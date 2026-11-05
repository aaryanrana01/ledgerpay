import mongoose from 'mongoose';
import { Account, LedgerEntry, Transaction, User } from '../models/index.js';
import { withTransaction } from '../db/mongoose.js';
import { ApiError } from '../utils/ApiError.js';
import { env } from '../config/env.js';
import { feeForAmount } from '../utils/money.js';
import { getSystemAccount, postTransaction } from './ledger.service.js';

/** Every user gets exactly one wallet per currency, created on registration. */
export async function ensureUserAccount(userId, session = null) {
  const existing = await Account.findOne({ userId, currency: env.CURRENCY, kind: 'USER' }).session(session);
  if (existing) return existing;

  const [created] = await Account.create(
    [{ userId, kind: 'USER', currency: env.CURRENCY, balanceMinor: 0, entryCount: 0 }],
    session ? { session } : {}
  );
  return created;
}

export async function getAccountForUser(userId) {
  const account = await Account.findOne({ userId, currency: env.CURRENCY, kind: 'USER' });
  if (!account) throw ApiError.notFound('ACCOUNT_NOT_FOUND', 'No wallet found for this account.');
  return account;
}

/** Rolling 24h outbound total, used to enforce the daily cap. */
async function outboundLast24h(userId, session) {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const [row] = await Transaction.aggregate([
    {
      $match: {
        sourceUserId: new mongoose.Types.ObjectId(String(userId)),
        type: { $in: ['TRANSFER', 'WITHDRAWAL'] },
        status: 'POSTED',
        createdAt: { $gte: since },
      },
    },
    { $group: { _id: null, total: { $sum: { $add: ['$amountMinor', '$feeMinor'] } } } },
  ]).session(session);

  return row?.total ?? 0;
}

/**
 * Peer-to-peer transfer.
 *
 * Three legs when a fee applies: debit sender (amount + fee), credit recipient
 * (amount), credit the fee account (fee). Still sums to zero.
 */
export async function transfer({ senderUserId, recipientWalletTag, amountMinor, note = '', idempotencyKey = null }) {
  if (amountMinor < env.MIN_TRANSFER_MINOR) {
    throw ApiError.badRequest('AMOUNT_TOO_SMALL', `Minimum transfer is ${env.MIN_TRANSFER_MINOR / 100} ${env.CURRENCY}.`);
  }
  if (amountMinor > env.MAX_TRANSFER_MINOR) {
    throw ApiError.badRequest('AMOUNT_TOO_LARGE', `Single transfers are capped at ${env.MAX_TRANSFER_MINOR / 100} ${env.CURRENCY}.`);
  }

  const recipient = await User.findOne({ walletTag: String(recipientWalletTag).toLowerCase().replace(/^@/, '') });
  if (!recipient) throw ApiError.notFound('RECIPIENT_NOT_FOUND', 'No one is using that wallet tag.');
  if (String(recipient._id) === String(senderUserId)) {
    throw ApiError.badRequest('SELF_TRANSFER', 'You cannot send money to yourself.');
  }
  if (recipient.status !== 'ACTIVE') {
    throw ApiError.forbidden('RECIPIENT_UNAVAILABLE', 'That wallet cannot receive money right now.');
  }

  const sender = await User.findById(senderUserId).lean();
  const feeMinor = feeForAmount(amountMinor, env.TRANSFER_FEE_BPS);

  return withTransaction(async (session) => {
    const spentToday = await outboundLast24h(senderUserId, session);
    if (spentToday + amountMinor + feeMinor > env.DAILY_TRANSFER_LIMIT_MINOR) {
      throw ApiError.badRequest('DAILY_LIMIT_EXCEEDED', 'This transfer would exceed your 24-hour sending limit.', {
        limitMinor: env.DAILY_TRANSFER_LIMIT_MINOR,
        usedMinor: spentToday,
      });
    }

    const source = await ensureUserAccount(senderUserId, session);
    const dest = await ensureUserAccount(recipient._id, session);

    const legs = [
      { accountId: source._id, direction: 'DEBIT', amountMinor: amountMinor + feeMinor },
      { accountId: dest._id, direction: 'CREDIT', amountMinor },
    ];
    if (feeMinor > 0) {
      const feeAccount = await getSystemAccount('FEES', session);
      legs.push({ accountId: feeAccount._id, direction: 'CREDIT', amountMinor: feeMinor });
    }

    const { transaction } = await postTransaction(session, {
      type: 'TRANSFER',
      legs,
      amountMinor,
      feeMinor,
      note,
      sourceAccountId: source._id,
      destAccountId: dest._id,
      sourceUserId: senderUserId,
      destUserId: recipient._id,
      initiatedBy: senderUserId,
      idempotencyKey,
      metadata: {
        recipientWalletTag: recipient.walletTag,
        recipientName: recipient.fullName,
        senderWalletTag: sender?.walletTag ?? null,
        senderName: sender?.fullName ?? null,
      },
    });

    const refreshed = await Account.findById(source._id).session(session).lean();
    return { transaction: transaction.toObject(), balanceMinor: refreshed.balanceMinor };
  });
}

/** Simulated rail deposit — funded from the settlement account, so books stay balanced. */
export async function topUp({ userId, amountMinor, note = 'Wallet top-up', idempotencyKey = null }) {
  if (amountMinor < env.MIN_TRANSFER_MINOR) {
    throw ApiError.badRequest('AMOUNT_TOO_SMALL', 'That top-up amount is too small.');
  }
  if (amountMinor > env.MAX_TRANSFER_MINOR) {
    throw ApiError.badRequest('AMOUNT_TOO_LARGE', 'That top-up amount is too large.');
  }

  return withTransaction(async (session) => {
    const account = await ensureUserAccount(userId, session);
    const settlement = await getSystemAccount('SETTLEMENT', session);

    const { transaction } = await postTransaction(session, {
      type: 'TOP_UP',
      legs: [
        { accountId: settlement._id, direction: 'DEBIT', amountMinor },
        { accountId: account._id, direction: 'CREDIT', amountMinor },
      ],
      amountMinor,
      note,
      sourceAccountId: settlement._id,
      destAccountId: account._id,
      destUserId: userId,
      initiatedBy: userId,
      idempotencyKey,
      metadata: { rail: 'SIMULATED_UPI' },
    });

    const refreshed = await Account.findById(account._id).session(session).lean();
    return { transaction: transaction.toObject(), balanceMinor: refreshed.balanceMinor };
  });
}

/** Simulated payout to a bank account. */
export async function withdraw({ userId, amountMinor, note = 'Withdrawal to bank', idempotencyKey = null }) {
  if (amountMinor < env.MIN_TRANSFER_MINOR) {
    throw ApiError.badRequest('AMOUNT_TOO_SMALL', 'That withdrawal amount is too small.');
  }

  return withTransaction(async (session) => {
    const account = await ensureUserAccount(userId, session);
    const settlement = await getSystemAccount('SETTLEMENT', session);

    const { transaction } = await postTransaction(session, {
      type: 'WITHDRAWAL',
      legs: [
        { accountId: account._id, direction: 'DEBIT', amountMinor },
        { accountId: settlement._id, direction: 'CREDIT', amountMinor },
      ],
      amountMinor,
      note,
      sourceAccountId: account._id,
      destAccountId: settlement._id,
      sourceUserId: userId,
      initiatedBy: userId,
      idempotencyKey,
      metadata: { rail: 'SIMULATED_IMPS' },
    });

    const refreshed = await Account.findById(account._id).session(session).lean();
    return { transaction: transaction.toObject(), balanceMinor: refreshed.balanceMinor };
  });
}

/**
 * Reversal — the correct way to undo money movement.
 *
 * The original transaction is never edited or deleted. A compensating
 * transaction with mirrored legs is posted and the two are linked, so the audit
 * trail shows both what happened and what corrected it.
 */
export async function reverseTransaction({ transactionId, actor }) {
  return withTransaction(async (session) => {
    const original = await Transaction.findById(transactionId).session(session);
    if (!original) throw ApiError.notFound('TRANSACTION_NOT_FOUND', 'That transaction does not exist.');
    if (original.status === 'REVERSED') {
      throw ApiError.conflict('ALREADY_REVERSED', 'This transaction has already been reversed.');
    }
    if (original.type === 'REVERSAL') {
      throw ApiError.badRequest('CANNOT_REVERSE_REVERSAL', 'A reversal cannot itself be reversed.');
    }

    const isSender = String(original.sourceUserId) === String(actor.id);
    if (!isSender && actor.role !== 'ADMIN') {
      throw ApiError.forbidden('NOT_YOUR_TRANSACTION', 'Only the sender can reverse this transfer.');
    }

    const ageMinutes = (Date.now() - original.createdAt.getTime()) / 60_000;
    if (actor.role !== 'ADMIN' && ageMinutes > env.REVERSAL_WINDOW_MINUTES) {
      throw ApiError.badRequest(
        'REVERSAL_WINDOW_CLOSED',
        `Transfers can only be reversed within ${env.REVERSAL_WINDOW_MINUTES} minutes.`
      );
    }

    // Mirror the original legs exactly, flipping direction.
    const originalEntries = await LedgerEntry.find({ transactionId: original._id }).session(session).lean();
    const legs = originalEntries.map((entry) => ({
      accountId: entry.accountId,
      direction: entry.direction === 'DEBIT' ? 'CREDIT' : 'DEBIT',
      amountMinor: entry.amountMinor,
    }));

    const { transaction: reversal } = await postTransaction(session, {
      type: 'REVERSAL',
      legs,
      amountMinor: original.amountMinor,
      feeMinor: original.feeMinor,
      note: `Reversal of ${original.reference}`,
      sourceAccountId: original.destAccountId,
      destAccountId: original.sourceAccountId,
      sourceUserId: original.destUserId,
      destUserId: original.sourceUserId,
      initiatedBy: actor.id,
      reversalOf: original._id,
      metadata: { originalReference: original.reference, reversedBy: actor.role },
    });

    original.status = 'REVERSED';
    original.reversedBy = reversal._id;
    await original.save({ session });

    return { reversal: reversal.toObject(), originalReference: original.reference };
  });
}

/**
 * Cursor pagination, not offset pagination.
 *
 * `skip` degrades linearly and can duplicate or drop rows when new transactions
 * arrive mid-scroll. A keyset cursor on (createdAt, _id) is stable and uses the
 * compound index directly.
 */
function encodeCursor(doc) {
  return Buffer.from(`${doc.createdAt.toISOString()}|${doc._id}`).toString('base64url');
}

function decodeCursor(cursor) {
  try {
    const [iso, id] = Buffer.from(cursor, 'base64url').toString('utf8').split('|');
    const createdAt = new Date(iso);
    if (Number.isNaN(createdAt.getTime()) || !mongoose.isValidObjectId(id)) return null;
    return { createdAt, id: new mongoose.Types.ObjectId(id) };
  } catch {
    return null;
  }
}

export async function listTransactions({ userId, limit = 20, cursor = null, type = null, direction = null }) {
  const uid = new mongoose.Types.ObjectId(String(userId));

  const participation = [{ sourceUserId: uid }, { destUserId: uid }];
  const filter = { $and: [{ $or: participation }] };

  if (direction === 'in') filter.$and = [{ destUserId: uid }];
  if (direction === 'out') filter.$and = [{ sourceUserId: uid }];
  if (type) filter.$and.push({ type });

  if (cursor) {
    const decoded = decodeCursor(cursor);
    if (!decoded) throw ApiError.badRequest('BAD_CURSOR', 'That pagination cursor is not valid.');
    filter.$and.push({
      $or: [
        { createdAt: { $lt: decoded.createdAt } },
        { createdAt: decoded.createdAt, _id: { $lt: decoded.id } },
      ],
    });
  }

  const docs = await Transaction.find(filter)
    .sort({ createdAt: -1, _id: -1 })
    .limit(limit + 1)
    .lean();

  const hasMore = docs.length > limit;
  const page = hasMore ? docs.slice(0, limit) : docs;

  return {
    items: page.map((doc) => shapeTransaction(doc, userId)),
    nextCursor: hasMore ? encodeCursor(page[page.length - 1]) : null,
  };
}

/** Presents a transaction from one participant's point of view. */
export function shapeTransaction(doc, viewerId) {
  const outgoing = String(doc.sourceUserId ?? '') === String(viewerId);
  return {
    id: String(doc._id),
    reference: doc.reference,
    type: doc.type,
    status: doc.status,
    direction: outgoing ? 'OUT' : 'IN',
    amountMinor: doc.amountMinor,
    feeMinor: doc.feeMinor ?? 0,
    currency: doc.currency,
    note: doc.note,
    counterparty: outgoing
      ? doc.metadata?.recipientWalletTag ?? doc.metadata?.rail ?? 'bank'
      : doc.metadata?.senderWalletTag ?? doc.metadata?.rail ?? 'wallet',
    createdAt: doc.createdAt,
    reversalOf: doc.reversalOf ? String(doc.reversalOf) : null,
    reversedBy: doc.reversedBy ? String(doc.reversedBy) : null,
  };
}

/** Ledger legs for one transaction — the double-entry view the UI expands into. */
export async function getTransactionEntries(transactionId, userId) {
  const transaction = await Transaction.findById(transactionId).lean();
  if (!transaction) throw ApiError.notFound('TRANSACTION_NOT_FOUND', 'That transaction does not exist.');

  const isParticipant =
    String(transaction.sourceUserId) === String(userId) || String(transaction.destUserId) === String(userId);
  if (!isParticipant) throw ApiError.forbidden('NOT_A_PARTICIPANT', 'You were not part of this transaction.');

  const entries = await LedgerEntry.find({ transactionId }).sort({ seq: 1 }).lean();

  return {
    transaction: shapeTransaction(transaction, userId),
    entries: entries.map((entry) => ({
      direction: entry.direction,
      amountMinor: entry.amountMinor,
      balanceAfterMinor: entry.balanceAfterMinor,
      seq: entry.seq,
      // Only the viewer's own running balance is disclosed.
      mine: String(entry.userId ?? '') === String(userId),
      accountKind: entry.userId ? 'USER' : 'SYSTEM',
      hash: entry.hash,
      prevHash: entry.prevHash,
    })),
  };
}

/** Headline numbers for the dashboard: 30-day in/out plus a 14-day daily series. */
export async function getSummary(userId) {
  const uid = new mongoose.Types.ObjectId(String(userId));
  const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const seriesSince = new Date(Date.now() - 13 * 24 * 60 * 60 * 1000);

  const [totals, series] = await Promise.all([
    Transaction.aggregate([
      { $match: { status: 'POSTED', createdAt: { $gte: since }, $or: [{ sourceUserId: uid }, { destUserId: uid }] } },
      {
        $group: {
          _id: null,
          sentMinor: { $sum: { $cond: [{ $eq: ['$sourceUserId', uid] }, '$amountMinor', 0] } },
          receivedMinor: { $sum: { $cond: [{ $eq: ['$destUserId', uid] }, '$amountMinor', 0] } },
          count: { $sum: 1 },
        },
      },
    ]),
    Transaction.aggregate([
      { $match: { status: 'POSTED', createdAt: { $gte: seriesSince }, $or: [{ sourceUserId: uid }, { destUserId: uid }] } },
      {
        $group: {
          _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } },
          outMinor: { $sum: { $cond: [{ $eq: ['$sourceUserId', uid] }, '$amountMinor', 0] } },
          inMinor: { $sum: { $cond: [{ $eq: ['$destUserId', uid] }, '$amountMinor', 0] } },
        },
      },
      { $sort: { _id: 1 } },
    ]),
  ]);

  const byDay = new Map(series.map((row) => [row._id, row]));
  const days = [];
  for (let i = 13; i >= 0; i -= 1) {
    const date = new Date(Date.now() - i * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const row = byDay.get(date);
    days.push({ date, inMinor: row?.inMinor ?? 0, outMinor: row?.outMinor ?? 0 });
  }

  return {
    windowDays: 30,
    sentMinor: totals[0]?.sentMinor ?? 0,
    receivedMinor: totals[0]?.receivedMinor ?? 0,
    transactionCount: totals[0]?.count ?? 0,
    dailySeries: days,
  };
}
