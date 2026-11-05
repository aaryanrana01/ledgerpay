/**
 * THE LEDGER ENGINE
 * =================
 *
 * This is the heart of the project. Read this file first.
 *
 * The core idea: money is never "subtracted from A and added to B". Instead,
 * every movement of money is recorded as a set of *legs* that must sum to zero.
 *
 *   Arjun sends 250.00 to Priya
 *   ---------------------------
 *   leg 1:  DEBIT  Arjun's account   250.00
 *   leg 2:  CREDIT Priya's account   250.00
 *                                    -------
 *   credits - debits                   0.00   <-- must always be true
 *
 * Those legs are written into the `ledgerentries` collection, which is
 * append-only. The `balanceMinor` field on an Account is just a cached total
 * for fast reads; the ledger is the real source of truth. scripts/reconcile.js
 * recomputes balances from the ledger and complains if they disagree.
 */

import { Account, LedgerEntry, Transaction } from '../models/index.js';
import { ApiError } from '../utils/ApiError.js';
import { computeEntryHash, GENESIS_HASH, makeReference } from '../utils/hash.js';
import { env } from '../config/env.js';

/**
 * The platform's own accounts.
 *
 * Why these exist: when a user tops up their wallet, the money has to come
 * *from* somewhere, or the books would not balance. It comes from SETTLEMENT,
 * which represents "money we hold at our bank". SETTLEMENT is allowed to go
 * negative because it is the counterparty for the entire system.
 */
export const SYSTEM_ACCOUNTS = {
  SETTLEMENT: 'SYSTEM:SETTLEMENT',
  FEES: 'SYSTEM:FEES',
};

/** Creates the system accounts if they do not exist yet. Called once on boot. */
export async function ensureSystemAccounts() {
  const specs = [
    { systemKey: SYSTEM_ACCOUNTS.SETTLEMENT, kind: 'SETTLEMENT' },
    { systemKey: SYSTEM_ACCOUNTS.FEES, kind: 'FEES' },
  ];

  const created = {};

  for (const spec of specs) {
    // upsert = "insert it if missing, otherwise leave it exactly as it is"
    // eslint-disable-next-line no-await-in-loop
    created[spec.kind] = await Account.findOneAndUpdate(
      { systemKey: spec.systemKey },
      {
        $setOnInsert: {
          systemKey: spec.systemKey,
          kind: spec.kind,
          currency: env.CURRENCY,
          balanceMinor: 0,
          entryCount: 0,
          allowNegative: true,
          userId: null,
        },
      },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
  }

  return created;
}

export async function getSystemAccount(kind, session = null) {
  const systemKey = kind === 'FEES' ? SYSTEM_ACCOUNTS.FEES : SYSTEM_ACCOUNTS.SETTLEMENT;

  const query = Account.findOne({ systemKey });
  if (session) query.session(session);

  const account = await query;
  if (!account) {
    throw ApiError.internal('System accounts are missing. Restart the server to create them.');
  }
  return account;
}

/**
 * Checks that a set of legs is valid before we touch any account.
 *
 * If this ever throws it means the calling code has a bug, not that the user
 * sent something wrong, so it raises a 500 rather than a 400.
 */
function assertLegsAreBalanced(legs) {
  if (!Array.isArray(legs) || legs.length < 2) {
    throw ApiError.internal('A transaction needs at least two legs.');
  }

  for (const leg of legs) {
    if (!Number.isSafeInteger(leg.amountMinor) || leg.amountMinor <= 0) {
      throw ApiError.internal(`Leg amount must be a positive whole number, got ${leg.amountMinor}`);
    }
  }

  const totalDebits = legs
    .filter((leg) => leg.direction === 'DEBIT')
    .reduce((sum, leg) => sum + leg.amountMinor, 0);

  const totalCredits = legs
    .filter((leg) => leg.direction === 'CREDIT')
    .reduce((sum, leg) => sum + leg.amountMinor, 0);

  if (totalDebits !== totalCredits) {
    throw ApiError.internal(`Unbalanced transaction: debits ${totalDebits} != credits ${totalCredits}`);
  }
}

/**
 * Applies ONE leg: moves the account balance, then writes the ledger entry.
 *
 * ---------------------------------------------------------------------------
 * THE MOST IMPORTANT TEN LINES IN THE PROJECT
 *
 * The naive way to prevent an overdraft is:
 *
 *     const account = await Account.findById(id);      // read
 *     if (account.balanceMinor < amount) throw ...     // check
 *     account.balanceMinor -= amount;
 *     await account.save();                            // write
 *
 * That is broken. If two transfers arrive at the same moment, BOTH read the
 * old balance, BOTH see enough money, and BOTH write. The account goes
 * negative and the platform has lost real money.
 *
 * The fix below moves the check *inside the query filter*, so the database
 * performs the read and the write as one indivisible operation. If the balance
 * is too low the filter matches zero documents, the update does nothing, and
 * we get back null. There is no gap in between for a second request to slip
 * into.
 *
 * tests/concurrency.test.js proves this with 100 simultaneous transfers.
 * ---------------------------------------------------------------------------
 */
async function applyLeg(session, leg, transactionContext) {
  const { transactionId, transactionRef, currency, occurredAt } = transactionContext;

  // A DEBIT decreases the balance, a CREDIT increases it.
  const balanceChange = leg.direction === 'CREDIT' ? leg.amountMinor : -leg.amountMinor;

  // STEP 1 - build the filter. For debits, the "do you have enough money?"
  // check lives here rather than in an if-statement further up.
  const filter = { _id: leg.accountId, status: 'ACTIVE' };

  if (balanceChange < 0) {
    filter.$or = [
      { allowNegative: true },                     // system accounts may go negative
      { balanceMinor: { $gte: leg.amountMinor } }, // user accounts may not
    ];
  }

  // STEP 2 - apply the change atomically. entryCount doubles as a per-account
  // counter, so incrementing it here also assigns this entry its seq number.
  const account = await Account.findOneAndUpdate(
    filter,
    {
      $inc: { balanceMinor: balanceChange, entryCount: 1 },
      $set: { lastEntryAt: occurredAt },
    },
    { session, new: true }
  );

  // STEP 3 - if nothing matched, work out why so the user gets a useful error.
  if (!account) {
    const existing = await Account.findById(leg.accountId).session(session);

    if (!existing) {
      throw ApiError.notFound('ACCOUNT_NOT_FOUND', 'That wallet does not exist.');
    }
    if (existing.status !== 'ACTIVE') {
      throw ApiError.forbidden('ACCOUNT_NOT_ACTIVE', `This wallet is ${existing.status.toLowerCase()}.`);
    }
    throw ApiError.badRequest(
      'INSUFFICIENT_FUNDS',
      'Not enough balance to complete this transfer.',
      { availableMinor: existing.balanceMinor, requiredMinor: leg.amountMinor }
    );
  }

  // STEP 4 - find the previous entry on this account so we can chain onto it.
  const previousEntry = await LedgerEntry.findOne({ accountId: account._id })
    .sort({ seq: -1 })
    .session(session)
    .lean();

  // STEP 5 - build the entry and hash it together with the previous hash.
  const entry = {
    transactionId,
    transactionRef,
    accountId: account._id,
    userId: account.userId,
    direction: leg.direction,
    amountMinor: leg.amountMinor,
    currency,
    balanceAfterMinor: account.balanceMinor,
    seq: account.entryCount, // incremented in step 2, so unique per account
    prevHash: previousEntry ? previousEntry.hash : GENESIS_HASH,
    createdAt: occurredAt,
  };
  entry.hash = computeEntryHash(entry);

  const [savedEntry] = await LedgerEntry.create([entry], { session });
  return { account, entry: savedEntry };
}

/**
 * Writes one complete, balanced transaction.
 *
 * MUST be called inside a session opened by withTransaction(), so that either
 * every leg lands or none of them do.
 */
export async function postTransaction(session, {
  type,
  legs,
  currency = env.CURRENCY,
  amountMinor,
  feeMinor = 0,
  note = '',
  sourceAccountId = null,
  destAccountId = null,
  sourceUserId = null,
  destUserId = null,
  initiatedBy = null,
  idempotencyKey = null,
  reversalOf = null,
  metadata = {},
}) {
  // 1. Refuse to write anything that does not balance.
  assertLegsAreBalanced(legs);

  // 2. Create the business-level record first.
  //
  //    Note: we deliberately do NOT set createdAt ourselves. The Transaction
  //    schema has `timestamps: true`, which means Mongoose owns that field.
  //    Setting it manually as well would mean two pieces of code writing the
  //    same value. Instead we let Mongoose set it and read the result back,
  //    then reuse that exact timestamp for every ledger entry below.
  const [transaction] = await Transaction.create(
    [{
      reference: makeReference(type === 'REVERSAL' ? 'RV' : 'LP'),
      type,
      status: 'POSTED',
      currency,
      amountMinor,
      feeMinor,
      sourceAccountId,
      destAccountId,
      sourceUserId,
      destUserId,
      note,
      idempotencyKey,
      initiatedBy,
      reversalOf,
      metadata,
    }],
    { session }
  );

  const occurredAt = transaction.createdAt;

  // 3. Apply the legs in a fixed order (sorted by account id).
  //    Always touching accounts in the same order turns potential deadlocks
  //    into ordinary write conflicts, which withTransaction() retries cleanly.
  const orderedLegs = [...legs].sort((a, b) => String(a.accountId).localeCompare(String(b.accountId)));

  const applied = [];

  for (const leg of orderedLegs) {
    // Sequential on purpose. Promise.all here would interleave operations on a
    // single database connection and corrupt the per-account sequence numbers.
    // eslint-disable-next-line no-await-in-loop
    const result = await applyLeg(session, leg, {
      transactionId: transaction._id,
      transactionRef: transaction.reference,
      currency,
      occurredAt,
    });
    applied.push(result);
  }

  return { transaction, applied };
}

/**
 * Re-reads one account's whole history and checks three things:
 *
 *   1. Each entry points at the previous entry's hash (the chain is unbroken).
 *   2. Recomputing each hash gives the value that was stored (nothing edited).
 *   3. Adding the entries up gives the balance each entry claimed to leave.
 *
 * If someone edits a row directly in the database, this reports the exact
 * sequence number where the numbers stop adding up.
 *
 * Powers GET /api/wallet/integrity.
 */
export async function verifyAccountChain(accountId) {
  const entries = await LedgerEntry.find({ accountId }).sort({ seq: 1 }).lean();

  let expectedPrevHash = GENESIS_HASH;
  let runningBalance = 0;

  for (const entry of entries) {
    if (entry.prevHash !== expectedPrevHash) {
      return { valid: false, checked: entries.length, brokenAtSeq: entry.seq, reason: 'CHAIN_BROKEN' };
    }

    if (computeEntryHash(entry) !== entry.hash) {
      return { valid: false, checked: entries.length, brokenAtSeq: entry.seq, reason: 'HASH_MISMATCH' };
    }

    runningBalance += entry.direction === 'CREDIT' ? entry.amountMinor : -entry.amountMinor;

    if (runningBalance !== entry.balanceAfterMinor) {
      return { valid: false, checked: entries.length, brokenAtSeq: entry.seq, reason: 'BALANCE_DRIFT' };
    }

    expectedPrevHash = entry.hash;
  }

  // Finally: does the cached balance on the Account match the ledger total?
  const account = await Account.findById(accountId).lean();

  if (account && account.balanceMinor !== runningBalance) {
    return {
      valid: false,
      checked: entries.length,
      brokenAtSeq: null,
      reason: 'CACHED_BALANCE_DRIFT',
      cachedBalanceMinor: account.balanceMinor,
      ledgerBalanceMinor: runningBalance,
    };
  }

  return {
    valid: true,
    checked: entries.length,
    ledgerBalanceMinor: runningBalance,
    headHash: entries.length ? entries[entries.length - 1].hash : GENESIS_HASH,
  };
}

/**
 * System-wide health check on the books.
 *
 * Two things must hold across the entire database:
 *   - total debits === total credits (money is only moved, never created)
 *   - every account's cached balance === the sum of its own ledger entries
 */
export async function reconcileSystem() {
  const [totals] = await LedgerEntry.aggregate([
    {
      $group: {
        _id: null,
        debits: { $sum: { $cond: [{ $eq: ['$direction', 'DEBIT'] }, '$amountMinor', 0] } },
        credits: { $sum: { $cond: [{ $eq: ['$direction', 'CREDIT'] }, '$amountMinor', 0] } },
      },
    },
  ]);

  const driftingAccounts = await LedgerEntry.aggregate([
    {
      // Sum each account's entries: credits add, debits subtract.
      $group: {
        _id: '$accountId',
        ledgerBalance: {
          $sum: {
            $cond: [
              { $eq: ['$direction', 'CREDIT'] },
              '$amountMinor',
              { $multiply: ['$amountMinor', -1] },
            ],
          },
        },
      },
    },
    { $lookup: { from: 'accounts', localField: '_id', foreignField: '_id', as: 'account' } },
    { $unwind: '$account' },
    {
      $project: {
        accountId: '$_id',
        ledgerBalance: 1,
        cachedBalance: '$account.balanceMinor',
        drift: { $subtract: ['$account.balanceMinor', '$ledgerBalance'] },
      },
    },
    { $match: { drift: { $ne: 0 } } }, // only report the broken ones
  ]);

  const totalDebitsMinor = totals?.debits ?? 0;
  const totalCreditsMinor = totals?.credits ?? 0;

  return {
    balanced: totalDebitsMinor === totalCreditsMinor && driftingAccounts.length === 0,
    totalDebitsMinor,
    totalCreditsMinor,
    driftingAccounts,
  };
}
