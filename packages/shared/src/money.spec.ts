import { describe, expect, it } from 'vitest';
import { centsEqual, centsGreaterThan, fromCents, hasAtMostTwoDecimals, moneyAmountSchema, toCents } from './money';

describe('toCents - the one dollars-to-cents conversion every money-accepting field reuses', () => {
  it('converts 19.99 to exactly 1999', () => {
    expect(toCents(19.99)).toBe(1999);
  });

  it('does not drift on 0.1 + 0.2-style IEEE754 noise', () => {
    expect(0.1 + 0.2).not.toBe(0.3); // the raw float noise this function exists to absorb
    expect(toCents(0.1 + 0.2)).toBe(30);
  });

  it('converts a range of ordinary two-decimal amounts exactly, with no off-by-one cent', () => {
    expect(toCents(0)).toBe(0);
    expect(toCents(0.01)).toBe(1);
    expect(toCents(49.99)).toBe(4999);
    expect(toCents(250)).toBe(25000);
    expect(toCents(1249.0)).toBe(124900);
    expect(toCents(250.1 + 0.2)).toBe(25030); // the exact case used in refund-verifier.spec.ts
  });

  it('rounds rather than truncates on genuine sub-cent input', () => {
    expect(toCents(19.995)).toBe(2000);
    expect(toCents(19.994)).toBe(1999);
  });
});

describe('fromCents - the inverse conversion PrivilegedRefundRunner uses to rebuild a dollar amount from stored cents', () => {
  it('round-trips every cent value toCents can produce', () => {
    for (const dollars of [0.01, 19.99, 49.99, 250, 1249.0, 124900 / 100]) {
      expect(fromCents(toCents(dollars))).toBeCloseTo(dollars, 2);
      expect(hasAtMostTwoDecimals(fromCents(toCents(dollars)))).toBe(true);
    }
  });

  it('converts 1999 to exactly 19.99', () => {
    expect(fromCents(1999)).toBe(19.99);
  });
});

describe('hasAtMostTwoDecimals', () => {
  it('accepts whole numbers and exact two-decimal amounts', () => {
    expect(hasAtMostTwoDecimals(250)).toBe(true);
    expect(hasAtMostTwoDecimals(19.99)).toBe(true);
    expect(hasAtMostTwoDecimals(0.1 + 0.2)).toBe(true); // 0.30000000000000004 is still "two decimal places" in intent
  });

  it('rejects a genuine third decimal place', () => {
    expect(hasAtMostTwoDecimals(19.999)).toBe(false);
  });

  it('rejects non-finite input', () => {
    expect(hasAtMostTwoDecimals(NaN)).toBe(false);
    expect(hasAtMostTwoDecimals(Infinity)).toBe(false);
  });
});

describe('centsEqual / centsGreaterThan', () => {
  it('treats float-noise-equal dollar amounts as equal in cents', () => {
    expect(centsEqual(0.1 + 0.2, 0.3)).toBe(true);
  });

  it('compares via cents, not raw float subtraction', () => {
    expect(centsGreaterThan(19.99, 19.98)).toBe(true);
    expect(centsGreaterThan(19.98, 19.99)).toBe(false);
    expect(centsGreaterThan(19.99, 19.99)).toBe(false);
  });
});

describe('moneyAmountSchema', () => {
  it('accepts a positive, two-decimal amount', () => {
    expect(moneyAmountSchema.safeParse(19.99).success).toBe(true);
  });

  it('rejects zero and negative amounts', () => {
    expect(moneyAmountSchema.safeParse(0).success).toBe(false);
    expect(moneyAmountSchema.safeParse(-5).success).toBe(false);
  });

  it('rejects more than two decimal places', () => {
    expect(moneyAmountSchema.safeParse(19.999).success).toBe(false);
  });
});
