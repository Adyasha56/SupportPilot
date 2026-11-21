import { describe, expect, it } from 'vitest';
import { computeLockedUntil, computeLockoutMs } from './lockout';

const SETTINGS = { freeAttempts: 3, baseMs: 1_000, capMs: 900_000 };

describe('lockout schedule (item 3)', () => {
  it('the first freeAttempts failures never lock (0ms)', () => {
    expect(computeLockoutMs(1, SETTINGS)).toBe(0);
    expect(computeLockoutMs(2, SETTINGS)).toBe(0);
    expect(computeLockoutMs(3, SETTINGS)).toBe(0);
  });

  it('doubles starting from baseMs right after the free attempts are used up', () => {
    expect(computeLockoutMs(4, SETTINGS)).toBe(1_000);
    expect(computeLockoutMs(5, SETTINGS)).toBe(2_000);
    expect(computeLockoutMs(6, SETTINGS)).toBe(4_000);
    expect(computeLockoutMs(7, SETTINGS)).toBe(8_000);
  });

  it('is capped at 15 minutes and never exceeds it, however many failures accumulate', () => {
    expect(computeLockoutMs(20, SETTINGS)).toBe(900_000);
    expect(computeLockoutMs(100, SETTINGS)).toBe(900_000);
    expect(computeLockoutMs(1000, SETTINGS)).toBe(900_000);
  });

  it('reaches the cap by attempt 13 and stays there', () => {
    // base * 2^(13-3-1) = 1000 * 2^9 = 512000 < 900000; attempt 14 -> 1000*2^10=1024000 -> capped.
    expect(computeLockoutMs(13, SETTINGS)).toBe(512_000);
    expect(computeLockoutMs(14, SETTINGS)).toBe(900_000);
  });

  it('computeLockedUntil uses the injected clock, never a live one', () => {
    const now = new Date('2026-01-01T00:00:00.000Z');
    expect(computeLockedUntil(3, now, SETTINGS)).toBeNull();
    expect(computeLockedUntil(4, now, SETTINGS)).toEqual(new Date('2026-01-01T00:00:01.000Z'));
    expect(computeLockedUntil(7, now, SETTINGS)).toEqual(new Date('2026-01-01T00:00:08.000Z'));
  });
});
