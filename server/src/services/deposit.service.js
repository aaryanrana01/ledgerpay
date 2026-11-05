import { PaymentIntent, recordAudit } from '../models/index.js';
import { withTransaction } from '../db/mongoose.js';
import { ApiError } from '../utils/ApiError.js';
import { env } from '../config/env.js';
import { logger } from '../utils/logger.js';
import { makeReference } from '../utils/hash.js';
import { ensureUserAccount } from './wallet.service.js';
import { getSystemAccount, postTransaction } from './ledger.service.js';
import { razorpay, verifyCheckoutSignature } from './razorpay.client.js';

const MIN_DEPOSIT_MINOR = 100; // Razorpay's own floor is ₹1

/**
 * Step 1 of a deposit: create a Razorpay order and remember what we asked for.
 *
 * The amount is recorded here, server-side, and every later step credits THIS
 * amount. The browser never gets to say how much to add - if it did, a user
 * could pay ₹1 through checkout and then tell our verify endpoint they paid
 * ₹10,000.
 */
export async function createDepositIntent({ userId, amountMinor }) {
  if (amountMinor < MIN_DEPOSIT_MINOR) {
    throw ApiError.badRequest('AMOUNT_TOO_SMALL', 'The minimum amount you can add is ₹1.');
  }
  if (amountMinor > env.MAX_TRANSFER_MINOR) {
    throw ApiError.badRequest(
      'AMOUNT_TOO_LARGE',
      `You can add up to ₹${env.MAX_TRANSFER_MINOR / 100} at a time.`
    );
  }

  const receipt = makeReference('DEP');

  const order = await razorpay().orders.create({
    amount: amountMinor, // already in paise, which is what Razorpay wants
    currency: env.CURRENCY,
    receipt,
    notes: { userId: String(userId), purpose: 'wallet_top_up' },
  });

  const intent = await PaymentIntent.create({
    userId,
    amountMinor,
    currency: env.CURRENCY,
    razorpayOrderId: order.id,
    receipt,
    status: 'CREATED',
    notes: { razorpayOrderStatus: order.status },
  });

  logger.info('deposit.intent_created', { intentId: String(intent._id), orderId: order.id, amountMinor });

  return { intent, order };
}

/**
 * Credits the wallet, exactly once, no matter how many callers try.
 *
 * The CREATED -> SETTLING transition is a conditional update: the filter says
 * "only if the status is still CREATED". Two concurrent callers both attempt
 * it, MongoDB applies one, and the other matches zero documents and gets null
 * back. That loser then simply reports success, because the deposit IS being
 * settled - just not by them.
 *
 * This is the same technique as the overdraft guard in ledger.service.js:
 * put the precondition inside the write, rather than checking it beforehand
 * and hoping nothing changes in between.
 */
async function settleIntent(intent, { via, paymentId, method = null, bank = null }) {
  const claimed = await PaymentIntent.findOneAndUpdate(
    { _id: intent._id, status: 'CREATED' }, // <- the precondition
    { $set: { status: 'SETTLING', razorpayPaymentId: paymentId, method, bank } },
    { new: true }
  );

  if (!claimed) {
    // Someone else got there first, or it already finished.
    const current = await PaymentIntent.findById(intent._id).lean();

    if (current?.status === 'SETTLED') {
      return { alreadySettled: true, transactionRef: current.transactionRef, amountMinor: current.amountMinor };
    }
    if (current?.status === 'SETTLING') {
      return { alreadySettled: true, inProgress: true, amountMinor: current.amountMinor };
    }
    throw ApiError.conflict('DEPOSIT_NOT_SETTLEABLE', 'This payment can no longer be credited.');
  }

  try {
    const result = await withTransaction(async (session) => {
      const account = await ensureUserAccount(claimed.userId, session);
      const settlement = await getSystemAccount('SETTLEMENT', session);

      // Same double-entry shape as a manual top-up: money leaves the platform's
      // settlement account and lands in the user's wallet.
      const { transaction } = await postTransaction(session, {
        type: 'TOP_UP',
        legs: [
          { accountId: settlement._id, direction: 'DEBIT', amountMinor: claimed.amountMinor },
          { accountId: account._id, direction: 'CREDIT', amountMinor: claimed.amountMinor },
        ],
        amountMinor: claimed.amountMinor,
        note: bank ? `Added via ${bank} netbanking` : `Added via ${method ?? 'Razorpay'}`,
        sourceAccountId: settlement._id,
        destAccountId: account._id,
        destUserId: claimed.userId,
        initiatedBy: claimed.userId,
        metadata: {
          rail: 'RAZORPAY',
          method,
          bank,
          razorpayPaymentId: paymentId,
          razorpayOrderId: claimed.razorpayOrderId,
          settledVia: via,
        },
      });

      return transaction;
    });

    await PaymentIntent.updateOne(
      { _id: claimed._id },
      {
        $set: {
          status: 'SETTLED',
          settledVia: via,
          transactionId: result._id,
          transactionRef: result.reference,
        },
      }
    );

    logger.info('deposit.settled', {
      intentId: String(claimed._id),
      via,
      amountMinor: claimed.amountMinor,
      reference: result.reference,
    });

    return { alreadySettled: false, transactionRef: result.reference, amountMinor: claimed.amountMinor };
  } catch (error) {
    // Put it back so the other path (or a webhook retry) can try again.
    // Leaving it stuck in SETTLING would strand the user's money.
    await PaymentIntent.updateOne(
      { _id: claimed._id, status: 'SETTLING' },
      { $set: { status: 'CREATED' } }
    );
    logger.error('deposit.settle_failed', { intentId: String(claimed._id), message: error.message });
    throw error;
  }
}

/**
 * Path A: the browser reports success right after the checkout modal closes.
 *
 * Fast, but unreliable on its own - the user can close the tab, lose signal,
 * or their battery can die between paying and this call landing. That is why
 * path B exists.
 */
export async function settleFromCheckout({ userId, orderId, paymentId, signature }) {
  if (!verifyCheckoutSignature({ orderId, paymentId, signature })) {
    logger.warn('deposit.bad_signature', { orderId, paymentId, userId: String(userId) });
    await recordAudit({
      actorId: userId,
      action: 'payment.signature_invalid',
      outcome: 'FAILURE',
      entity: 'PaymentIntent',
      entityId: orderId,
    });
    throw ApiError.badRequest('SIGNATURE_INVALID', 'We could not verify that payment. Nothing was charged twice.');
  }

  const intent = await PaymentIntent.findOne({ razorpayOrderId: orderId });
  if (!intent) throw ApiError.notFound('INTENT_NOT_FOUND', 'That payment does not match any request.');

  // A valid signature proves the payment is real, not that it belongs to the
  // person currently signed in. Check ownership separately.
  if (String(intent.userId) !== String(userId)) {
    throw ApiError.forbidden('NOT_YOUR_PAYMENT', 'That payment belongs to another account.');
  }

  // Ask Razorpay what actually happened rather than trusting the browser.
  const payment = await razorpay().payments.fetch(paymentId);

  if (payment.order_id !== orderId) {
    throw ApiError.badRequest('ORDER_MISMATCH', 'That payment does not belong to this order.');
  }
  if (payment.amount !== intent.amountMinor) {
    // Should be impossible via checkout, but if it ever happens we want a loud
    // failure rather than crediting the wrong number.
    logger.error('deposit.amount_mismatch', {
      orderId,
      expected: intent.amountMinor,
      actual: payment.amount,
    });
    throw ApiError.badRequest('AMOUNT_MISMATCH', 'The paid amount does not match the request.');
  }
  if (!['captured', 'authorized'].includes(payment.status)) {
    throw ApiError.badRequest('PAYMENT_NOT_SUCCESSFUL', `That payment is currently ${payment.status}.`);
  }

  return settleIntent(intent, {
    via: 'CHECKOUT',
    paymentId,
    method: payment.method ?? null,
    bank: payment.bank ?? null,
  });
}

/**
 * Path B: Razorpay tells our server directly, over the internet.
 *
 * Slower, but it does not depend on the user's browser staying alive. In
 * production this is the path you actually trust; the checkout callback is
 * just a latency optimisation so the UI can update immediately.
 */
export async function settleFromWebhook(paymentEntity) {
  const intent = await PaymentIntent.findOne({ razorpayOrderId: paymentEntity.order_id });

  if (!intent) {
    logger.warn('webhook.unknown_order', { orderId: paymentEntity.order_id });
    return { ignored: true, reason: 'UNKNOWN_ORDER' };
  }
  if (paymentEntity.amount !== intent.amountMinor) {
    logger.error('webhook.amount_mismatch', {
      orderId: paymentEntity.order_id,
      expected: intent.amountMinor,
      actual: paymentEntity.amount,
    });
    return { ignored: true, reason: 'AMOUNT_MISMATCH' };
  }

  return settleIntent(intent, {
    via: 'WEBHOOK',
    paymentId: paymentEntity.id,
    method: paymentEntity.method ?? null,
    bank: paymentEntity.bank ?? null,
  });
}

/** Records a failed attempt so the history explains itself. */
export async function markIntentFailed(orderId, reason) {
  const updated = await PaymentIntent.findOneAndUpdate(
    { razorpayOrderId: orderId, status: 'CREATED' },
    { $set: { status: 'FAILED', failureReason: reason ?? 'Payment was not completed' } },
    { new: true }
  );
  return updated;
}

/** Deposit history for the payments page. */
export async function listDeposits(userId, limit = 20) {
  const rows = await PaymentIntent.find({ userId }).sort({ createdAt: -1 }).limit(limit).lean();

  return rows.map((row) => ({
    id: String(row._id),
    amountMinor: row.amountMinor,
    status: row.status,
    method: row.method,
    bank: row.bank,
    settledVia: row.settledVia,
    reference: row.transactionRef,
    razorpayPaymentId: row.razorpayPaymentId,
    failureReason: row.failureReason,
    createdAt: row.createdAt,
  }));
}
