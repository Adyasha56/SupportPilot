/**
 * Money is accepted and returned as decimal dollars (e.g. 49.99) for
 * readability, but every comparison converts to integer cents first so
 * floating-point representation never affects the result.
 */
export function toCents(amount: number): number {
  return Math.round(amount * 100);
}

export function hasAtMostTwoDecimals(amount: number): boolean {
  if (!Number.isFinite(amount)) {
    return false;
  }
  const scaled = amount * 100;
  return Math.abs(scaled - Math.round(scaled)) < 1e-6;
}

export function centsEqual(a: number, b: number): boolean {
  return toCents(a) === toCents(b);
}

export function centsGreaterThan(a: number, b: number): boolean {
  return toCents(a) > toCents(b);
}
