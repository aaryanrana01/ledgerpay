/**
 * Money is *never* a float in this codebase.
 *
 * Everything is stored and computed in integer minor units (paise for INR).
 * 12.34 becomes 1234. Formatting to a decimal string happens exactly once,
 * at the edge, and parsing happens exactly once, on input.
 */
export const MINOR_UNITS_PER_MAJOR = 100;

/** Parse user input ("1,240.50", "1240.5", 1240.5) into integer minor units. */
export function parseAmountToMinor(input) {
  if (typeof input === 'number') {
    if (!Number.isFinite(input)) return null;
    const minor = Math.round(input * MINOR_UNITS_PER_MAJOR);
    return Number.isSafeInteger(minor) ? minor : null;
  }
  if (typeof input !== 'string') return null;

  const cleaned = input.replace(/[\s,_]/g, '');
  if (!/^\d{1,15}(\.\d{1,2})?$/.test(cleaned)) return null;

  const [whole, fraction = ''] = cleaned.split('.');
  const paddedFraction = fraction.padEnd(2, '0');
  const minor = Number(whole) * MINOR_UNITS_PER_MAJOR + Number(paddedFraction);
  return Number.isSafeInteger(minor) ? minor : null;
}

/** 1234 -> "12.34". Plain string, no locale grouping — the UI does presentation. */
export function minorToDecimalString(minor) {
  const sign = minor < 0 ? '-' : '';
  const abs = Math.abs(minor);
  const whole = Math.floor(abs / MINOR_UNITS_PER_MAJOR);
  const fraction = String(abs % MINOR_UNITS_PER_MAJOR).padStart(2, '0');
  return `${sign}${whole}.${fraction}`;
}

/** Basis-point fee, rounded half-up, never negative. */
export function feeForAmount(amountMinor, bps) {
  if (!bps) return 0;
  return Math.round((amountMinor * bps) / 10_000);
}

export function assertPositiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${label} must be a positive safe integer, received ${value}`);
  }
}
