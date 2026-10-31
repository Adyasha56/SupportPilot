import { describe, expect, it } from 'vitest';
import { daysPastEstimate, daysSinceDelivery, remainingRefundable } from './derived-facts';

const NOW = new Date('2026-10-31T12:00:00.000Z');
const clock = () => NOW;

describe('daysSinceDelivery', () => {
  it('returns undefined when deliveredAt is missing', () => {
    expect(daysSinceDelivery(undefined, clock)).toBeUndefined();
  });

  it('returns 0 for a delivery less than 24 hours ago', () => {
    expect(daysSinceDelivery('2026-10-31T00:00:01.000Z', clock)).toBe(0);
  });

  it('returns 0 for a delivery exactly at now', () => {
    expect(daysSinceDelivery('2026-10-31T12:00:00.000Z', clock)).toBe(0);
  });

  it('returns 1 for a delivery exactly 24 hours ago', () => {
    expect(daysSinceDelivery('2026-10-30T12:00:00.000Z', clock)).toBe(1);
  });

  it('floors a partial day rather than rounding', () => {
    // 1 day and 23 hours ago -> still 1 whole day, not 2.
    expect(daysSinceDelivery('2026-10-29T13:00:00.000Z', clock)).toBe(1);
  });

  it('is unaffected by timezone offset in the input - only the absolute instant matters', () => {
    // 2026-10-30T12:00:00Z === 2026-10-30T17:00:00+05:00
    expect(daysSinceDelivery('2026-10-30T17:00:00.000+05:00', clock)).toBe(1);
  });

  it('returns undefined (never a negative number) for a delivery timestamp in the future', () => {
    expect(daysSinceDelivery('2026-11-01T00:00:00.000Z', clock)).toBeUndefined();
  });
});

describe('daysPastEstimate', () => {
  it('returns undefined when estimatedDelivery is missing', () => {
    expect(daysPastEstimate(undefined, clock)).toBeUndefined();
  });

  it('returns 0 when the estimate is still in the future (not late)', () => {
    expect(daysPastEstimate('2026-11-05T12:00:00.000Z', clock)).toBe(0);
  });

  it('returns 0 when the estimate is exactly now', () => {
    expect(daysPastEstimate('2026-10-31T12:00:00.000Z', clock)).toBe(0);
  });

  it('returns 1 for an estimate missed by exactly 24 hours', () => {
    expect(daysPastEstimate('2026-10-30T12:00:00.000Z', clock)).toBe(1);
  });

  it('floors a partial day rather than rounding', () => {
    expect(daysPastEstimate('2026-10-29T13:00:00.000Z', clock)).toBe(1);
  });
});

describe('remainingRefundable', () => {
  it('returns the full total in cents when nothing has been refunded', () => {
    expect(remainingRefundable(49.99, 0)).toBe(4999);
  });

  it('returns 0 when the order has already been fully refunded', () => {
    expect(remainingRefundable(49.99, 49.99)).toBe(0);
  });

  it('subtracts a partial refund correctly', () => {
    expect(remainingRefundable(100, 25)).toBe(7500);
  });

  it('never goes negative, even if alreadyRefunded exceeds the total (bad data)', () => {
    expect(remainingRefundable(50, 75)).toBe(0);
  });

  it('is not fooled by classic floating-point representation error (0.1 + 0.2 style inputs)', () => {
    expect(remainingRefundable(0.3, 0.1)).toBe(20);
  });
});
