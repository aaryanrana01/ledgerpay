import { feeForAmount, minorToDecimalString, parseAmountToMinor } from '../src/utils/money.js';
import { computeEntryHash, GENESIS_HASH } from '../src/utils/hash.js';

describe('money parsing', () => {
  test.each([
    ['250', 25_000],
    ['250.75', 25_075],
    ['0.01', 1],
    ['1,240.50', 124_050],
    [' 99.9 ', 9_990],
    [10.05, 1_005],
  ])('parses %p to %p paise', (input, expected) => {
    expect(parseAmountToMinor(input)).toBe(expected);
  });

  test.each(['abc', '10.999', '-5', '1e5', '', '10.', '.5', null, undefined, {}])(
    'rejects %p',
    (input) => {
      expect(parseAmountToMinor(input)).toBeNull();
    }
  );

  test('0.1 + 0.2 problems cannot occur because we never add floats', () => {
    const total = parseAmountToMinor('0.10') + parseAmountToMinor('0.20');
    expect(total).toBe(30);
    expect(minorToDecimalString(total)).toBe('0.30');
  });

  test('formats negative and sub-rupee amounts', () => {
    expect(minorToDecimalString(-4_250)).toBe('-42.50');
    expect(minorToDecimalString(7)).toBe('0.07');
  });

  test('fees round half-up and are zero when disabled', () => {
    expect(feeForAmount(10_000, 0)).toBe(0);
    expect(feeForAmount(10_000, 50)).toBe(50); // 0.5%
    expect(feeForAmount(333, 50)).toBe(2); // 1.665 -> 2
  });
});

describe('hash chain', () => {
  const base = {
    prevHash: GENESIS_HASH,
    transactionRef: 'LP-TEST-0001',
    accountId: '507f1f77bcf86cd799439011',
    direction: 'DEBIT',
    amountMinor: 5_000,
    balanceAfterMinor: 45_000,
    seq: 1,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
  };

  test('is deterministic', () => {
    expect(computeEntryHash(base)).toBe(computeEntryHash({ ...base }));
  });

  test('changing any field changes the hash', () => {
    const original = computeEntryHash(base);
    expect(computeEntryHash({ ...base, amountMinor: 5_001 })).not.toBe(original);
    expect(computeEntryHash({ ...base, balanceAfterMinor: 45_001 })).not.toBe(original);
    expect(computeEntryHash({ ...base, prevHash: 'a'.repeat(64) })).not.toBe(original);
  });
});
