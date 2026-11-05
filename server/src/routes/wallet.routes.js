import { Router } from 'express';
import { z } from 'zod';
import { authenticate } from '../middleware/authenticate.js';
import { validate } from '../middleware/validate.js';
import { idempotency } from '../middleware/idempotency.js';
import { moneyLimiter } from '../middleware/rateLimit.js';
import { parseAmountToMinor } from '../utils/money.js';
import { ApiError } from '../utils/ApiError.js';
import { env } from '../config/env.js';
import { User, recordAudit } from '../models/index.js';
import {
  getAccountForUser,
  getSummary,
  getTransactionEntries,
  listTransactions,
  reverseTransaction,
  topUp,
  transfer,
  withdraw,
} from '../services/wallet.service.js';
import { verifyAccountChain } from '../services/ledger.service.js';

const router = Router();
router.use(authenticate);

/** Accepts "1,240.50" or 1240.5 and hands the service integer paise. */
const amountField = z
  .union([z.string(), z.number()])
  .transform((value, ctx) => {
    const minor = parseAmountToMinor(value);
    if (minor === null || minor <= 0) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Enter an amount like 250 or 250.75.' });
      return z.NEVER;
    }
    return minor;
  });

const transferSchema = z.object({
  to: z.string().min(3, 'Enter a wallet tag.').max(21),
  amount: amountField,
  note: z.string().max(140).optional().default(''),
});

const amountOnlySchema = z.object({
  amount: amountField,
  note: z.string().max(140).optional().default(''),
});

const historySchema = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(20),
  cursor: z.string().optional(),
  type: z.enum(['TRANSFER', 'TOP_UP', 'WITHDRAWAL', 'REVERSAL']).optional(),
  direction: z.enum(['in', 'out']).optional(),
});

router.get('/', async (req, res, next) => {
  try {
    const account = await getAccountForUser(req.user.id);
    res.json({
      ok: true,
      data: {
        balanceMinor: account.balanceMinor,
        currency: account.currency,
        entryCount: account.entryCount,
        status: account.status,
        walletTag: req.user.walletTag,
        limits: {
          minTransferMinor: env.MIN_TRANSFER_MINOR,
          maxTransferMinor: env.MAX_TRANSFER_MINOR,
          dailyLimitMinor: env.DAILY_TRANSFER_LIMIT_MINOR,
          feeBps: env.TRANSFER_FEE_BPS,
        },
      },
    });
  } catch (error) {
    next(error);
  }
});

router.get('/summary', async (req, res, next) => {
  try {
    res.json({ ok: true, data: await getSummary(req.user.id) });
  } catch (error) {
    next(error);
  }
});

/** Confirms a wallet tag before the user commits to sending. */
router.get('/resolve/:walletTag', async (req, res, next) => {
  try {
    const tag = String(req.params.walletTag).toLowerCase().replace(/^@/, '');
    const user = await User.findOne({ walletTag: tag, status: 'ACTIVE' }).lean();
    if (!user) throw ApiError.notFound('RECIPIENT_NOT_FOUND', 'No one is using that wallet tag.');
    res.json({
      ok: true,
      data: { walletTag: user.walletTag, fullName: user.fullName, isSelf: String(user._id) === req.user.id },
    });
  } catch (error) {
    next(error);
  }
});

router.post(
  '/transfers',
  moneyLimiter,
  validate(transferSchema),
  idempotency('wallet.transfer'),
  async (req, res, next) => {
    try {
      const result = await transfer({
        senderUserId: req.user.id,
        recipientWalletTag: req.body.to,
        amountMinor: req.body.amount,
        note: req.body.note,
        idempotencyKey: req.headers['idempotency-key'],
      });

      await recordAudit({
        actorId: req.user.id,
        action: 'wallet.transfer',
        entity: 'Transaction',
        entityId: result.transaction.reference,
        ip: req.ip,
        meta: { amountMinor: req.body.amount, to: req.body.to },
      });

      res.status(201).json({
        ok: true,
        data: {
          reference: result.transaction.reference,
          amountMinor: result.transaction.amountMinor,
          feeMinor: result.transaction.feeMinor,
          balanceMinor: result.balanceMinor,
          createdAt: result.transaction.createdAt,
        },
      });
    } catch (error) {
      next(error);
    }
  }
);

router.post('/top-ups', moneyLimiter, validate(amountOnlySchema), idempotency('wallet.topup'), async (req, res, next) => {
  try {
    const result = await topUp({
      userId: req.user.id,
      amountMinor: req.body.amount,
      note: req.body.note || 'Wallet top-up',
      idempotencyKey: req.headers['idempotency-key'],
    });
    res.status(201).json({
      ok: true,
      data: {
        reference: result.transaction.reference,
        amountMinor: result.transaction.amountMinor,
        balanceMinor: result.balanceMinor,
      },
    });
  } catch (error) {
    next(error);
  }
});

router.post('/withdrawals', moneyLimiter, validate(amountOnlySchema), idempotency('wallet.withdraw'), async (req, res, next) => {
  try {
    const result = await withdraw({
      userId: req.user.id,
      amountMinor: req.body.amount,
      note: req.body.note || 'Withdrawal to bank',
      idempotencyKey: req.headers['idempotency-key'],
    });
    res.status(201).json({
      ok: true,
      data: {
        reference: result.transaction.reference,
        amountMinor: result.transaction.amountMinor,
        balanceMinor: result.balanceMinor,
      },
    });
  } catch (error) {
    next(error);
  }
});

router.get('/transactions', validate(historySchema, 'query'), async (req, res, next) => {
  try {
    const { limit, cursor, type, direction } = req.validatedQuery;
    res.json({ ok: true, data: await listTransactions({ userId: req.user.id, limit, cursor, type, direction }) });
  } catch (error) {
    next(error);
  }
});

/** The double-entry view: both legs of one transaction, with their chain hashes. */
router.get('/transactions/:id/entries', async (req, res, next) => {
  try {
    res.json({ ok: true, data: await getTransactionEntries(req.params.id, req.user.id) });
  } catch (error) {
    next(error);
  }
});

router.post('/transactions/:id/reverse', moneyLimiter, async (req, res, next) => {
  try {
    const result = await reverseTransaction({
      transactionId: req.params.id,
      actor: { id: req.user.id, role: req.user.role },
    });
    await recordAudit({
      actorId: req.user.id,
      action: 'wallet.reverse',
      entity: 'Transaction',
      entityId: result.originalReference,
      ip: req.ip,
    });
    res.status(201).json({ ok: true, data: result });
  } catch (error) {
    next(error);
  }
});

/** Recomputes the caller's hash chain from scratch and reports any tampering. */
router.get('/integrity', async (req, res, next) => {
  try {
    const account = await getAccountForUser(req.user.id);
    const result = await verifyAccountChain(account._id);
    res.json({ ok: true, data: result });
  } catch (error) {
    next(error);
  }
});

export default router;
