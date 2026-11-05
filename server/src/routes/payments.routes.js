import { Router } from 'express';
import { z } from 'zod';
import { authenticate } from '../middleware/authenticate.js';
import { validate } from '../middleware/validate.js';
import { moneyLimiter } from '../middleware/rateLimit.js';
import { idempotency } from '../middleware/idempotency.js';
import { parseAmountToMinor } from '../utils/money.js';
import { env, paymentsEnabled } from '../config/env.js';
import { recordAudit } from '../models/index.js';
import {
  createDepositIntent,
  listDeposits,
  markIntentFailed,
  settleFromCheckout,
} from '../services/deposit.service.js';
import { listPayouts, requestPayout } from '../services/payout.service.js';
import { publicKeyId } from '../services/razorpay.client.js';

const router = Router();
router.use(authenticate);

const amountField = z.union([z.string(), z.number()]).transform((value, ctx) => {
  const minor = parseAmountToMinor(value);
  if (minor === null || minor <= 0) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Enter an amount like 500 or 500.50.' });
    return z.NEVER;
  }
  return minor;
});

/** Tells the frontend whether to show online payment options at all. */
router.get('/config', (_req, res) => {
  res.json({
    ok: true,
    data: {
      enabled: paymentsEnabled,
      keyId: publicKeyId(), // publishable; the secret never leaves the server
      currency: env.CURRENCY,
      payoutProvider: env.PAYOUT_PROVIDER,
      minWithdrawalMinor: env.MIN_WITHDRAWAL_MINOR,
      maxAmountMinor: env.MAX_TRANSFER_MINOR,
    },
  });
});

/** Step 1 of adding money: create a Razorpay order. */
router.post(
  '/deposits',
  moneyLimiter,
  validate(z.object({ amount: amountField })),
  async (req, res, next) => {
    try {
      const { intent, order } = await createDepositIntent({
        userId: req.user.id,
        amountMinor: req.body.amount,
      });

      res.status(201).json({
        ok: true,
        data: {
          intentId: String(intent._id),
          orderId: order.id,
          amountMinor: intent.amountMinor,
          currency: intent.currency,
          keyId: publicKeyId(),
          // Prefill so the user does not retype what we already know.
          prefill: { name: req.user.doc.fullName, email: req.user.doc.email },
        },
      });
    } catch (error) {
      next(error);
    }
  }
);

/** Step 2 (fast path): the browser reports the checkout result. */
router.post(
  '/deposits/verify',
  moneyLimiter,
  validate(
    z.object({
      razorpay_order_id: z.string().min(4),
      razorpay_payment_id: z.string().min(4),
      razorpay_signature: z.string().min(16),
    })
  ),
  async (req, res, next) => {
    try {
      const result = await settleFromCheckout({
        userId: req.user.id,
        orderId: req.body.razorpay_order_id,
        paymentId: req.body.razorpay_payment_id,
        signature: req.body.razorpay_signature,
      });

      await recordAudit({
        actorId: req.user.id,
        action: 'payment.deposit_verified',
        entity: 'PaymentIntent',
        entityId: req.body.razorpay_order_id,
        ip: req.ip,
      });

      res.json({ ok: true, data: result });
    } catch (error) {
      next(error);
    }
  }
);

/** The user closed the modal or the bank declined. */
router.post('/deposits/abandon', validate(z.object({ orderId: z.string().min(4), reason: z.string().max(200).optional() })), async (req, res, next) => {
  try {
    await markIntentFailed(req.body.orderId, req.body.reason);
    res.json({ ok: true, data: { recorded: true } });
  } catch (error) {
    next(error);
  }
});

const payoutSchema = z
  .object({
    amount: amountField,
    mode: z.enum(['IMPS', 'NEFT', 'UPI']).default('IMPS'),
    destinationType: z.enum(['BANK_ACCOUNT', 'VPA']),
    name: z.string().min(2, 'Enter the account holder name.').max(80),
    accountNumber: z.string().optional(),
    ifsc: z.string().optional(),
    bankName: z.string().max(60).optional(),
    vpa: z.string().optional(),
  })
  .refine((data) => data.destinationType !== 'BANK_ACCOUNT' || Boolean(data.accountNumber && data.ifsc), {
    message: 'Bank withdrawals need an account number and IFSC.',
    path: ['accountNumber'],
  })
  .refine((data) => data.destinationType !== 'VPA' || Boolean(data.vpa), {
    message: 'Enter a UPI ID.',
    path: ['vpa'],
  });

/** Withdraw to a bank account or UPI ID. */
router.post(
  '/payouts',
  moneyLimiter,
  validate(payoutSchema),
  idempotency('payments.payout'),
  async (req, res, next) => {
    try {
      const payout = await requestPayout({
        userId: req.user.id,
        amountMinor: req.body.amount,
        mode: req.body.destinationType === 'VPA' ? 'UPI' : req.body.mode,
        destination: {
          type: req.body.destinationType,
          name: req.body.name,
          accountNumber: req.body.accountNumber,
          ifsc: req.body.ifsc?.toUpperCase(),
          bankName: req.body.bankName,
          vpa: req.body.vpa,
        },
      });

      await recordAudit({
        actorId: req.user.id,
        action: 'payment.payout_requested',
        entity: 'PayoutRequest',
        entityId: payout.reference,
        ip: req.ip,
        meta: { amountMinor: req.body.amount },
      });

      res.status(201).json({
        ok: true,
        data: {
          reference: payout.reference,
          amountMinor: payout.amountMinor,
          status: payout.status,
          mode: payout.mode,
        },
      });
    } catch (error) {
      next(error);
    }
  }
);

/** Combined history for the Payments page. */
router.get('/', async (req, res, next) => {
  try {
    const [deposits, payouts] = await Promise.all([
      listDeposits(req.user.id, 25),
      listPayouts(req.user.id, 25),
    ]);
    res.json({ ok: true, data: { deposits, payouts } });
  } catch (error) {
    next(error);
  }
});

export default router;
