import crypto from 'node:crypto';
import { PayoutRequest } from '../models/index.js';
import { withTransaction } from '../db/mongoose.js';
import { ApiError } from '../utils/ApiError.js';
import { env } from '../config/env.js';
import { logger } from '../utils/logger.js';
import { makeReference } from '../utils/hash.js';
import { ensureUserAccount } from './wallet.service.js';
import { getSystemAccount, postTransaction } from './ledger.service.js';
import { razorpay } from './razorpay.client.js';

/** RBI-format IFSC: 4 letters, a 0, then 6 alphanumerics. */
export const IFSC_PATTERN = /^[A-Z]{4}0[A-Z0-9]{6}$/;
export const VPA_PATTERN = /^[a-zA-Z0-9._-]{2,64}@[a-zA-Z][a-zA-Z0-9.-]{1,63}$/;

/**
 * Takes money out of the wallet and hands it to a payout provider.
 *
 * ORDER OF OPERATIONS MATTERS. The wallet is debited first, inside a database
 * transaction, and only then is the provider called:
 *
 *   debit wallet  ->  call provider  ->  wait for confirmation
 *
 * The reverse order looks equally reasonable and is dangerous: if the server
 * crashed between "bank sent the money" and "wallet debited", the user would
 * keep their balance AND have the cash. Debiting first means the worst case is
 * that we hold money we later return, which a reversal fixes cleanly.
 */
export async function requestPayout({ userId, amountMinor, destination, mode = 'IMPS' }) {
  if (amountMinor < env.MIN_WITHDRAWAL_MINOR) {
    throw ApiError.badRequest(
      'AMOUNT_TOO_SMALL',
      `The minimum withdrawal is ₹${env.MIN_WITHDRAWAL_MINOR / 100}.`
    );
  }
  if (amountMinor > env.MAX_TRANSFER_MINOR) {
    throw ApiError.badRequest('AMOUNT_TOO_LARGE', 'That withdrawal is above the per-transaction cap.');
  }

  validateDestination(destination);

  const reference = makeReference('WDR');
  const idempotencyKey = crypto.randomUUID();

  // --- 1. Debit the wallet (atomic, will refuse if the balance is short) ---
  const { transaction } = await withTransaction(async (session) => {
    const account = await ensureUserAccount(userId, session);
    const settlement = await getSystemAccount('SETTLEMENT', session);

    return postTransaction(session, {
      type: 'WITHDRAWAL',
      legs: [
        { accountId: account._id, direction: 'DEBIT', amountMinor },
        { accountId: settlement._id, direction: 'CREDIT', amountMinor },
      ],
      amountMinor,
      note:
        destination.type === 'VPA'
          ? `Withdrawal to ${destination.vpa}`
          : `Withdrawal to ${destination.bankName ?? 'bank'} ••••${destination.accountNumber.slice(-4)}`,
      sourceAccountId: account._id,
      destAccountId: settlement._id,
      sourceUserId: userId,
      initiatedBy: userId,
      metadata: { rail: 'PAYOUT', mode, payoutReference: reference },
    });
  });

  // --- 2. Record the request. Money is now held, not yet sent. ---
  const payout = await PayoutRequest.create({
    userId,
    reference,
    amountMinor,
    currency: env.CURRENCY,
    mode,
    provider: env.PAYOUT_PROVIDER,
    idempotencyKey,
    status: 'REQUESTED',
    debitTransactionId: transaction._id,
    destination: {
      type: destination.type,
      name: destination.name,
      // Only the last four digits are retained.
      accountLast4: destination.accountNumber ? destination.accountNumber.slice(-4) : null,
      ifsc: destination.ifsc ?? null,
      bankName: destination.bankName ?? null,
      vpa: destination.vpa ?? null,
    },
  });

  // --- 3. Hand it to the provider. Failures refund automatically. ---
  try {
    await dispatchToProvider(payout, destination);
  } catch (error) {
    logger.error('payout.dispatch_failed', { reference, message: error.message });
    await reversePayout(payout._id, error.message ?? 'The payout could not be created.');
    throw ApiError.badRequest(
      'PAYOUT_FAILED',
      'We could not start that withdrawal. Your balance has not changed.'
    );
  }

  return payout;
}

function validateDestination(destination) {
  if (!destination || !destination.name || destination.name.trim().length < 2) {
    throw ApiError.badRequest('BENEFICIARY_NAME_REQUIRED', 'Enter the account holder name.');
  }

  if (destination.type === 'BANK_ACCOUNT') {
    if (!/^\d{6,18}$/.test(destination.accountNumber ?? '')) {
      throw ApiError.badRequest('ACCOUNT_NUMBER_INVALID', 'Enter a valid account number (6–18 digits).');
    }
    if (!IFSC_PATTERN.test((destination.ifsc ?? '').toUpperCase())) {
      throw ApiError.badRequest('IFSC_INVALID', 'Enter a valid IFSC code, for example HDFC0001234.');
    }
    return;
  }

  if (destination.type === 'VPA') {
    if (!VPA_PATTERN.test(destination.vpa ?? '')) {
      throw ApiError.badRequest('VPA_INVALID', 'Enter a valid UPI ID, for example name@bank.');
    }
    return;
  }

  throw ApiError.badRequest('DESTINATION_INVALID', 'Choose a bank account or a UPI ID.');
}

/**
 * Two providers behind one interface.
 *
 * 'razorpayx' is the real thing. It needs a RazorpayX account with completed
 * business KYC, which a personal account cannot get - so it is not the default.
 *
 * 'simulated' runs the identical state machine locally with a delay, so the
 * whole withdrawal flow (hold, process, confirm, reverse) is exercisable
 * offline. The application code above and below this function does not know or
 * care which one is active, which is the point of the abstraction.
 */
async function dispatchToProvider(payout, destination) {
  if (payout.provider === 'razorpayx') {
    return dispatchRazorpayX(payout, destination);
  }
  return dispatchSimulated(payout);
}

async function dispatchRazorpayX(payout, destination) {
  if (!env.RAZORPAYX_ACCOUNT_NUMBER) {
    throw new Error('RAZORPAYX_ACCOUNT_NUMBER is not configured.');
  }

  const fundAccount =
    destination.type === 'VPA'
      ? { account_type: 'vpa', vpa: { address: destination.vpa } }
      : {
          account_type: 'bank_account',
          bank_account: {
            name: destination.name,
            ifsc: destination.ifsc.toUpperCase(),
            account_number: destination.accountNumber,
          },
        };

  // Composite Payout API: creates the contact, the fund account and the payout
  // in one call. account_number here is OUR RazorpayX account, never the
  // beneficiary's - passing the beneficiary's number is a classic mistake and
  // the payout simply fails.
  const response = await razorpay().payouts.create(
    {
      account_number: env.RAZORPAYX_ACCOUNT_NUMBER,
      amount: payout.amountMinor,
      currency: payout.currency,
      mode: payout.mode,
      purpose: 'payout',
      queue_if_low_balance: true,
      reference_id: payout.reference,
      narration: 'LedgerPay withdrawal',
      fund_account: {
        ...fundAccount,
        contact: { name: destination.name, type: 'customer', reference_id: String(payout.userId) },
      },
    },
    // Mandatory on the Payouts API since March 2025, and the reason a network
    // retry cannot pay the same person twice.
    { 'X-Payout-Idempotency': payout.idempotencyKey }
  );

  await PayoutRequest.updateOne(
    { _id: payout._id },
    { $set: { status: 'PROCESSING', providerPayoutId: response.id } }
  );

  logger.info('payout.dispatched', { reference: payout.reference, payoutId: response.id });
  return response;
}

/**
 * Local stand-in for a bank. Moves to PROCESSING immediately, then PROCESSED
 * after a delay, mimicking real settlement timing.
 *
 * A payout ending in 0000 is failed on purpose, so the reversal path can be
 * demonstrated without waiting for a real bank to bounce something.
 */
async function dispatchSimulated(payout) {
  await PayoutRequest.updateOne(
    { _id: payout._id },
    { $set: { status: 'PROCESSING', providerPayoutId: `pout_sim_${payout.idempotencyKey.slice(0, 12)}` } }
  );

  const shouldFail = payout.destination.accountLast4 === '0000';

  setTimeout(async () => {
    try {
      if (shouldFail) {
        await reversePayout(payout._id, 'Beneficiary account rejected the credit.');
      } else {
        await confirmPayout(payout._id, `SIM${Date.now().toString().slice(-9)}`);
      }
    } catch (error) {
      logger.error('payout.simulation_failed', { reference: payout.reference, message: error.message });
    }
  }, env.SIMULATED_PAYOUT_DELAY_MS).unref();

  return { id: payout.providerPayoutId, simulated: true };
}

/** The bank confirmed it. Nothing to do to the ledger - the debit already happened. */
export async function confirmPayout(payoutId, utr = null) {
  const updated = await PayoutRequest.findOneAndUpdate(
    { _id: payoutId, status: { $in: ['REQUESTED', 'PROCESSING'] } },
    { $set: { status: 'PROCESSED', utr } },
    { new: true }
  );

  if (updated) logger.info('payout.processed', { reference: updated.reference, utr });
  return updated;
}

/**
 * The payout bounced. Give the money back.
 *
 * Note this posts a NEW compensating transaction rather than deleting the
 * original debit - same principle as transfer reversals. The history shows
 * both that money left and that it came back.
 */
export async function reversePayout(payoutId, reason) {
  // Claim the reversal atomically so a webhook and a retry cannot refund twice.
  const claimed = await PayoutRequest.findOneAndUpdate(
    { _id: payoutId, status: { $in: ['REQUESTED', 'PROCESSING'] } },
    { $set: { status: 'REVERSED', failureReason: reason } },
    { new: true }
  );

  if (!claimed) return null; // already terminal, nothing to refund

  const { transaction } = await withTransaction(async (session) => {
    const account = await ensureUserAccount(claimed.userId, session);
    const settlement = await getSystemAccount('SETTLEMENT', session);

    return postTransaction(session, {
      type: 'REVERSAL',
      legs: [
        { accountId: settlement._id, direction: 'DEBIT', amountMinor: claimed.amountMinor },
        { accountId: account._id, direction: 'CREDIT', amountMinor: claimed.amountMinor },
      ],
      amountMinor: claimed.amountMinor,
      note: `Withdrawal ${claimed.reference} returned`,
      sourceAccountId: settlement._id,
      destAccountId: account._id,
      destUserId: claimed.userId,
      initiatedBy: claimed.userId,
      reversalOf: claimed.debitTransactionId,
      metadata: { rail: 'PAYOUT', payoutReference: claimed.reference, reason },
    });
  });

  await PayoutRequest.updateOne({ _id: claimed._id }, { $set: { refundTransactionId: transaction._id } });

  logger.info('payout.reversed', { reference: claimed.reference, reason });
  return claimed;
}

export async function listPayouts(userId, limit = 20) {
  const rows = await PayoutRequest.find({ userId }).sort({ createdAt: -1 }).limit(limit).lean();

  return rows.map((row) => ({
    id: String(row._id),
    reference: row.reference,
    amountMinor: row.amountMinor,
    status: row.status,
    mode: row.mode,
    provider: row.provider,
    utr: row.utr,
    failureReason: row.failureReason,
    destination: {
      type: row.destination.type,
      name: row.destination.name,
      label:
        row.destination.type === 'VPA'
          ? row.destination.vpa
          : `${row.destination.bankName ?? 'Bank'} ••••${row.destination.accountLast4}`,
    },
    createdAt: row.createdAt,
  }));
}

/** Called by the RazorpayX webhook handler. */
export async function handlePayoutWebhook(payoutEntity, event) {
  const payout = await PayoutRequest.findOne({
    $or: [{ providerPayoutId: payoutEntity.id }, { reference: payoutEntity.reference_id }],
  });

  if (!payout) return { ignored: true, reason: 'UNKNOWN_PAYOUT' };

  if (event === 'payout.processed') {
    await confirmPayout(payout._id, payoutEntity.utr ?? null);
    return { handled: true };
  }

  if (event === 'payout.reversed' || event === 'payout.failed') {
    await reversePayout(payout._id, payoutEntity.status_details?.description ?? 'The bank returned this payout.');
    return { handled: true };
  }

  return { ignored: true, reason: 'UNHANDLED_EVENT' };
}
