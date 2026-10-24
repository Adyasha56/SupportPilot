import { describe, expect, it } from 'vitest';
import { centsEqual, centsGreaterThan, hasAtMostTwoDecimals, toCents } from '../src/money';

describe('toCents', () => {
  it('converts decimal dollars to integer cents', () => {
    expect(toCents(49.99)).toBe(4999);
    expect(toCents(0.1)).toBe(10);
    expect(toCents(1249.0)).toBe(124900);
  });
});

describe('hasAtMostTwoDecimals', () => {
  it('accepts amounts with zero, one, or two decimal places', () => {
    expect(hasAtMostTwoDecimals(50)).toBe(true);
    expect(hasAtMostTwoDecimals(49.9)).toBe(true);
    expect(hasAtMostTwoDecimals(49.99)).toBe(true);
  });

  it('rejects amounts with three or more decimal places', () => {
    expect(hasAtMostTwoDecimals(49.999)).toBe(false);
    expect(hasAtMostTwoDecimals(10.005)).toBe(false);
  });

  it('is not fooled by classic floating-point representation error', () => {
    // 0.1 + 0.2 !== 0.3 in raw IEEE-754 arithmetic; this must still read as "two decimals".
    expect(hasAtMostTwoDecimals(0.1 + 0.2)).toBe(true);
  });
});

describe('centsEqual / centsGreaterThan', () => {
  it('treats float-imprecise equal amounts as equal', () => {
    expect(centsEqual(0.1 + 0.2, 0.3)).toBe(true);
  });

  it('compares amounts correctly at the cent boundary', () => {
    expect(centsGreaterThan(49.99, 49.98)).toBe(true);
    expect(centsGreaterThan(49.99, 49.99)).toBe(false);
    expect(centsGreaterThan(49.98, 49.99)).toBe(false);
  });
});
