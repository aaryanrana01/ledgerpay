import crypto from 'node:crypto';

/** First link of every per-account chain. */
export const GENESIS_HASH = '0'.repeat(64);

export function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

/**
 * Tamper-evident ledger.
 *
 * Each ledger entry commits to the hash of the previous entry *on the same
 * account*, so the account's history is a chain. Editing a historic row in the
 * database — or deleting one — breaks every hash after it, and
 * GET /api/wallet/integrity will report the exact sequence number where the
 * chain diverges.
 */
export function computeEntryHash({
  prevHash,
  transactionRef,
  accountId,
  direction,
  amountMinor,
  balanceAfterMinor,
  seq,
  createdAt,
}) {
  const payload = [
    prevHash,
    transactionRef,
    String(accountId),
    direction,
    String(amountMinor),
    String(balanceAfterMinor),
    String(seq),
    new Date(createdAt).toISOString(),
  ].join('|');
  return sha256(payload);
}

/** URL-safe random identifier used for transaction references and token families. */
export function randomId(bytes = 12) {
  return crypto.randomBytes(bytes).toString('base64url');
}

/** Sortable, human-quotable reference: LP-<base36 time>-<random>. */
export function makeReference(prefix = 'LP') {
  const time = Date.now().toString(36).toUpperCase();
  const rand = crypto.randomBytes(4).toString('hex').toUpperCase();
  return `${prefix}-${time}-${rand}`;
}
