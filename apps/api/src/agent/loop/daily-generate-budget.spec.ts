import { describe, expect, it } from 'vitest';
import { InMemoryDailyGenerateBudgetGuard } from './daily-generate-budget';

describe('InMemoryDailyGenerateBudgetGuard', () => {
  it('allows consumption up to the max, then denies without throwing', () => {
    const guard = new InMemoryDailyGenerateBudgetGuard(3, () => new Date('2026-11-02T00:00:00.000Z'));

    expect(guard.tryConsume()).toBe(true);
    expect(guard.tryConsume()).toBe(true);
    expect(guard.tryConsume()).toBe(true);
    expect(guard.tryConsume()).toBe(false);
    expect(guard.tryConsume()).toBe(false);
  });

  it('resets the count once the window has fully elapsed', () => {
    let now = new Date('2026-11-02T00:00:00.000Z').getTime();
    const clock = () => new Date(now);
    const windowMs = 1000;
    const guard = new InMemoryDailyGenerateBudgetGuard(1, clock, windowMs);

    expect(guard.tryConsume()).toBe(true);
    expect(guard.tryConsume()).toBe(false);

    now += windowMs;
    expect(guard.tryConsume()).toBe(true);
    expect(guard.tryConsume()).toBe(false);
  });

  it('does not reset early, one millisecond before the window elapses', () => {
    let now = new Date('2026-11-02T00:00:00.000Z').getTime();
    const clock = () => new Date(now);
    const windowMs = 1000;
    const guard = new InMemoryDailyGenerateBudgetGuard(1, clock, windowMs);

    expect(guard.tryConsume()).toBe(true);
    now += windowMs - 1;
    expect(guard.tryConsume()).toBe(false);
  });

  it('release() refunds one ticket, allowing another consume at the same count', () => {
    const guard = new InMemoryDailyGenerateBudgetGuard(1, () => new Date('2026-11-02T00:00:00.000Z'));

    expect(guard.tryConsume()).toBe(true);
    expect(guard.tryConsume()).toBe(false);
    guard.release();
    expect(guard.tryConsume()).toBe(true);
    expect(guard.tryConsume()).toBe(false);
  });

  it('release() never goes negative when called with nothing consumed', () => {
    const guard = new InMemoryDailyGenerateBudgetGuard(1, () => new Date('2026-11-02T00:00:00.000Z'));

    guard.release();
    guard.release();
    expect(guard.tryConsume()).toBe(true);
    expect(guard.tryConsume()).toBe(false);
  });
});
