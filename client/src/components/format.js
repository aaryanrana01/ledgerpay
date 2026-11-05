/** Presentation-only. All arithmetic happens on the server, in integer paise. */

const grouper = new Intl.NumberFormat('en-IN');

export function formatMinor(minor, { sign = false } = {}) {
  const negative = minor < 0;
  const abs = Math.abs(minor);
  const whole = grouper.format(Math.floor(abs / 100));
  const paise = String(abs % 100).padStart(2, '0');
  const prefix = negative ? '-' : sign ? '+' : '';
  return `${prefix}${whole}.${paise}`;
}

/** Splits the figure so the paise can be set in a lighter colour. */
export function splitMinor(minor) {
  const abs = Math.abs(minor);
  return {
    negative: minor < 0,
    whole: grouper.format(Math.floor(abs / 100)),
    paise: String(abs % 100).padStart(2, '0'),
  };
}

export function formatDate(value) {
  return new Date(value).toLocaleDateString('en-IN', { day: '2-digit', month: 'short' });
}

export function formatDateTime(value) {
  return new Date(value).toLocaleString('en-IN', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function shortHash(hash) {
  if (!hash) return '—';
  return `${hash.slice(0, 10)}…${hash.slice(-6)}`;
}

const TYPE_LABELS = {
  TRANSFER: 'Transfer',
  TOP_UP: 'Top-up',
  WITHDRAWAL: 'Withdrawal',
  REVERSAL: 'Reversal',
};

export function describe(txn) {
  if (txn.type === 'TOP_UP') return 'Added from bank';
  if (txn.type === 'WITHDRAWAL') return 'Sent to bank';
  if (txn.type === 'REVERSAL') return txn.direction === 'IN' ? 'Refund received' : 'Refund sent';
  return txn.direction === 'OUT' ? `To @${txn.counterparty}` : `From @${txn.counterparty}`;
}

export { TYPE_LABELS };
