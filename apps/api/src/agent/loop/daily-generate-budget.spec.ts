import { describe, expect, it } from 'vitest';
import {
  DailyGenerateBudgetGuard,
  InMemoryDailyGenerateBudgetGuard,
  TenantAndGlobalGenerateBudgetGuard,
  TenantGenerateBudgetGuard,
} from './daily-generate-budget';

describe('InMemoryDailyGenerateBudgetGuard', () => {
  it('allows consumption up to the max, then denies without throwing', () => {
    const guard = new InMemoryDailyGenerateBudgetGuard(3, () => new Date('2026-11-02T00:00:00.000Z'));

    expect(guard.tryConsume('acme')).toBe(true);
    expect(guard.tryConsume('acme')).toBe(true);
    expect(guard.tryConsume('acme')).toBe(true);
    expect(guard.tryConsume('acme')).toBe(false);
    expect(guard.tryConsume('acme')).toBe(false);
  });

  it('resets the count once the window has fully elapsed', () => {
    let now = new Date('2026-11-02T00:00:00.000Z').getTime();
    const clock = () => new Date(now);
    const windowMs = 1000;
    const guard = new InMemoryDailyGenerateBudgetGuard(1, clock, windowMs);

    expect(guard.tryConsume('acme')).toBe(true);
    expect(guard.tryConsume('acme')).toBe(false);

    now += windowMs;
    expect(guard.tryConsume('acme')).toBe(true);
    expect(guard.tryConsume('acme')).toBe(false);
  });

  it('does not reset early, one millisecond before the window elapses', () => {
    let now = new Date('2026-11-02T00:00:00.000Z').getTime();
    const clock = () => new Date(now);
    const windowMs = 1000;
    const guard = new InMemoryDailyGenerateBudgetGuard(1, clock, windowMs);

    expect(guard.tryConsume('acme')).toBe(true);
    now += windowMs - 1;
    expect(guard.tryConsume('acme')).toBe(false);
  });

  it('release() refunds one ticket, allowing another consume at the same count', () => {
    const guard = new InMemoryDailyGenerateBudgetGuard(1, () => new Date('2026-11-02T00:00:00.000Z'));

    expect(guard.tryConsume('acme')).toBe(true);
    expect(guard.tryConsume('acme')).toBe(false);
    guard.release('acme');
    expect(guard.tryConsume('acme')).toBe(true);
    expect(guard.tryConsume('acme')).toBe(false);
  });

  it('release() never goes negative when called with nothing consumed', () => {
    const guard = new InMemoryDailyGenerateBudgetGuard(1, () => new Date('2026-11-02T00:00:00.000Z'));

    guard.release('acme');
    guard.release('acme');
    expect(guard.tryConsume('acme')).toBe(true);
    expect(guard.tryConsume('acme')).toBe(false);
  });
});

describe('TenantGenerateBudgetGuard', () => {
  it('tracks each tenant independently', () => {
    const guard = new TenantGenerateBudgetGuard({ maxPerTenantPerDay: 1, maxEntries: 10 }, () => new Date('2026-11-06T12:00:00.000Z'));

    expect(guard.tryConsume('acme')).toBe(true);
    expect(guard.tryConsume('acme')).toBe(false); // acme's own ticket is spent
    expect(guard.tryConsume('globex')).toBe(true); // globex is unaffected by acme's usage
  });

  it('resets at UTC midnight, not after a fixed rolling duration', () => {
    let now = new Date('2026-11-06T23:59:59.000Z').getTime();
    const clock = () => new Date(now);
    const guard = new TenantGenerateBudgetGuard({ maxPerTenantPerDay: 1, maxEntries: 10 }, clock);

    expect(guard.tryConsume('acme')).toBe(true);
    expect(guard.tryConsume('acme')).toBe(false);

    now += 2000; // crosses into 2026-11-07T00:00:01.000Z - a new UTC day, only 2s later
    expect(guard.tryConsume('acme')).toBe(true);
  });

  it('does not reset one millisecond before UTC midnight', () => {
    let now = new Date('2026-11-06T23:59:58.000Z').getTime();
    const clock = () => new Date(now);
    const guard = new TenantGenerateBudgetGuard({ maxPerTenantPerDay: 1, maxEntries: 10 }, clock);

    expect(guard.tryConsume('acme')).toBe(true);
    now += 1999; // still 2026-11-06T23:59:59.999Z
    expect(guard.tryConsume('acme')).toBe(false);
  });

  it('release() refunds one ticket for that tenant only', () => {
    const guard = new TenantGenerateBudgetGuard({ maxPerTenantPerDay: 1, maxEntries: 10 }, () => new Date('2026-11-06T12:00:00.000Z'));

    expect(guard.tryConsume('acme')).toBe(true);
    guard.release('acme');
    expect(guard.tryConsume('acme')).toBe(true);
    expect(guard.tryConsume('globex')).toBe(true); // globex was never touched
  });

  it('evicts the oldest tenant once at capacity, bounding memory', () => {
    const guard = new TenantGenerateBudgetGuard({ maxPerTenantPerDay: 1, maxEntries: 2 }, () => new Date('2026-11-06T12:00:00.000Z'));

    guard.tryConsume('tenant-a');
    guard.tryConsume('tenant-b');
    guard.tryConsume('tenant-c'); // evicts tenant-a's entry

    // tenant-a's slate is wiped (its old entry was evicted) - it gets a fresh ticket.
    expect(guard.tryConsume('tenant-a')).toBe(true);
  });
});

describe('TenantAndGlobalGenerateBudgetGuard', () => {
  function makeGlobal(overrides: Partial<DailyGenerateBudgetGuard> = {}): DailyGenerateBudgetGuard & { consumeCalls: string[]; releaseCalls: string[] } {
    const consumeCalls: string[] = [];
    const releaseCalls: string[] = [];
    return {
      tryConsume: (tenantId) => {
        consumeCalls.push(tenantId);
        return overrides.tryConsume ? overrides.tryConsume(tenantId) : true;
      },
      release: (tenantId) => {
        releaseCalls.push(tenantId);
        overrides.release?.(tenantId);
      },
      consumeCalls,
      releaseCalls,
    };
  }

  it('consumes from both layers when both allow it', () => {
    const tenantGuard = new TenantGenerateBudgetGuard({ maxPerTenantPerDay: 50, maxEntries: 10 }, () => new Date('2026-11-06T12:00:00.000Z'));
    const global = makeGlobal();
    const composite = new TenantAndGlobalGenerateBudgetGuard(tenantGuard, global);

    expect(composite.tryConsume('acme')).toBe(true);
    expect(global.consumeCalls).toEqual(['acme']);
  });

  it('checks the tenant layer FIRST - a tenant-exhausted call never reaches the global guard at all', () => {
    const tenantGuard = new TenantGenerateBudgetGuard({ maxPerTenantPerDay: 1, maxEntries: 10 }, () => new Date('2026-11-06T12:00:00.000Z'));
    const global = makeGlobal();
    const composite = new TenantAndGlobalGenerateBudgetGuard(tenantGuard, global);

    expect(composite.tryConsume('acme')).toBe(true);
    expect(composite.tryConsume('acme')).toBe(false); // tenant's own limit (1) is already spent
    expect(global.consumeCalls).toEqual(['acme']); // only the first call ever reached the global guard
  });

  it('refunds the tenant ticket when the global guard denies it, so the net cost to the tenant is zero', () => {
    const tenantGuard = new TenantGenerateBudgetGuard({ maxPerTenantPerDay: 50, maxEntries: 10 }, () => new Date('2026-11-06T12:00:00.000Z'));
    const global = makeGlobal({ tryConsume: () => false }); // global pool is exhausted
    const composite = new TenantAndGlobalGenerateBudgetGuard(tenantGuard, global);

    expect(composite.tryConsume('acme')).toBe(false);
    // The tenant's own ticket was refunded - a second call still has its full allowance.
    expect(tenantGuard.tryConsume('acme')).toBe(true);
  });

  it('release() releases both layers', () => {
    const tenantGuard = new TenantGenerateBudgetGuard({ maxPerTenantPerDay: 1, maxEntries: 10 }, () => new Date('2026-11-06T12:00:00.000Z'));
    const global = makeGlobal();
    const composite = new TenantAndGlobalGenerateBudgetGuard(tenantGuard, global);

    expect(composite.tryConsume('acme')).toBe(true);
    expect(composite.tryConsume('acme')).toBe(false); // tenant ticket spent

    composite.release('acme');
    expect(global.releaseCalls).toEqual(['acme']);
    expect(composite.tryConsume('acme')).toBe(true); // tenant ticket was refunded too
  });
});
