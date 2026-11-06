/**
 * Both methods take a `tenantId` (Stage 4 item 2) even though the plain
 * in-memory implementation below ignores it - the GLOBAL guard's whole
 * point is one shared ticket pool across every tenant, so it has nothing
 * tenant-specific to do with the id. The parameter exists so every
 * implementation of this interface - this global one, the per-tenant one,
 * and the composite below - can be swapped in at the exact same call site
 * in run-agent.ts without that call site caring which kind of guard it has.
 */
export interface DailyGenerateBudgetGuard {
  /** Returns true and consumes one ticket if the budget allows it this call; returns false (consumes nothing) otherwise. */
  tryConsume(tenantId: string): boolean;
  /**
   * Stage 4 finding 3 - refunds one previously-consumed ticket. Used only
   * when a ticket was consumed but generate() then returned CIRCUIT_OPEN
   * (no real Gemini call happened, so nothing was really spent) - never
   * used for any other error code, since every other failure DID reach the
   * real API and genuinely counts against the day's budget.
   */
  release(tenantId: string): void;
}

/**
 * In-memory, SINGLE-PROCESS ONLY - same honest caveat as
 * TenantIngestionLock/FailedAttemptLimiter: this guard's count resets if
 * the process restarts, and is never shared across multiple instances of
 * the app. It exists to protect this project's own shared free-tier
 * Gemini quota from one runaway tenant/demo session exhausting it for
 * everyone, not as a real production rate limit (PROJECT.md section 13,
 * Stage 4 finding 7). Checked once per real generate() attempt - see
 * run-agent.ts's callStructured - never once per run, so a run that needs
 * a repair attempt or a compose call correctly spends more than one ticket.
 *
 * A ROLLING window anchored at whenever this guard last reset (not a
 * calendar-day boundary) - deliberately different from
 * TenantGenerateBudgetGuard below, which the Stage 4 item 2 spec requires
 * to use a UTC calendar day. This one is a single shared pool with no
 * per-tenant concept of "day" to align to, so a rolling window is simplest
 * and was already in place before this file needed a second budget layer.
 */
export class InMemoryDailyGenerateBudgetGuard implements DailyGenerateBudgetGuard {
  private windowStartMs: number;
  private count = 0;

  constructor(
    private readonly maxPerWindow: number,
    private readonly clock: () => Date,
    private readonly windowMs: number = 24 * 60 * 60 * 1000,
  ) {
    this.windowStartMs = clock().getTime();
  }

  tryConsume(_tenantId: string): boolean {
    const now = this.clock().getTime();
    if (now - this.windowStartMs >= this.windowMs) {
      this.windowStartMs = now;
      this.count = 0;
    }
    if (this.count >= this.maxPerWindow) {
      return false;
    }
    this.count += 1;
    return true;
  }

  release(_tenantId: string): void {
    if (this.count > 0) {
      this.count -= 1;
    }
  }
}

/**
 * The UTC calendar date this guard resets on, as `YYYY-MM-DD` - deliberately
 * NOT a rolling 24h-from-last-use window like InMemoryDailyGenerateBudgetGuard
 * above. "Per tenant per day" reads most naturally as a calendar day, and a
 * rolling window would let a tenant's effective limit drift based on
 * exactly when they first called in, which is harder to reason about and to
 * explain to a tenant admin asking "when does my limit reset."
 *
 * Documented and NOT changed to match it: Google's own Gemini free-tier
 * quota resets on its own boundary (reported as Pacific time, not UTC, and
 * not guaranteed to stay that way) - this guard's UTC-midnight reset is this
 * project's own, independent, more conservative layer, not an attempt to
 * mirror Google's actual reset moment. Being stricter (resetting later, in
 * most timezones) than the real provider quota is the safe direction to be
 * wrong in; being looser would not be.
 */
function utcDateKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export interface TenantGenerateBudgetGuardSettings {
  maxPerTenantPerDay: number;
  /**
   * Caps total memory against many distinct tenants, same reasoning as
   * FailedAttemptLimiter/RateLimiter's own maxEntries - oldest-inserted
   * tenant is evicted first once at capacity, not the least-recently-used
   * one (no extra bookkeeping needed for that, and this guard's job is
   * bounding memory, not fairness).
   */
  maxEntries: number;
}

/**
 * Per-tenant daily generate() budget - Stage 4 item 2. A bounded Map keyed
 * by tenantId, each entry independently resetting at UTC midnight (see
 * `utcDateKey` above), not a global rolling window.
 */
export class TenantGenerateBudgetGuard {
  private readonly buckets = new Map<string, { count: number; dayKey: string }>();

  constructor(
    private readonly settings: TenantGenerateBudgetGuardSettings,
    private readonly clock: () => Date,
  ) {}

  tryConsume(tenantId: string): boolean {
    const today = utcDateKey(this.clock());
    let entry = this.buckets.get(tenantId);

    if (!entry || entry.dayKey !== today) {
      if (!entry && this.buckets.size >= this.settings.maxEntries) {
        const oldestKey = this.buckets.keys().next().value;
        if (oldestKey !== undefined) {
          this.buckets.delete(oldestKey);
        }
      }
      entry = { count: 0, dayKey: today };
      this.buckets.set(tenantId, entry);
    }

    if (entry.count >= this.settings.maxPerTenantPerDay) {
      return false;
    }
    entry.count += 1;
    return true;
  }

  release(tenantId: string): void {
    const entry = this.buckets.get(tenantId);
    if (entry && entry.count > 0) {
      entry.count -= 1;
    }
  }
}

/**
 * Composite guard - Stage 4 item 2: checks the TENANT layer first, then the
 * GLOBAL layer, and refunds the tenant's ticket if the global check denies
 * it, so a tenant is never left "charged" for a ticket the run never
 * actually got to spend. `release()` (the CIRCUIT_OPEN undo path in
 * run-agent.ts) always releases both layers, since both were genuinely
 * consumed in the success case that path undoes - there is no case where
 * only one layer was charged and this is later called.
 */
export class TenantAndGlobalGenerateBudgetGuard implements DailyGenerateBudgetGuard {
  constructor(
    private readonly tenantGuard: TenantGenerateBudgetGuard,
    private readonly globalGuard: DailyGenerateBudgetGuard,
  ) {}

  tryConsume(tenantId: string): boolean {
    if (!this.tenantGuard.tryConsume(tenantId)) {
      return false;
    }
    if (!this.globalGuard.tryConsume(tenantId)) {
      this.tenantGuard.release(tenantId);
      return false;
    }
    return true;
  }

  release(tenantId: string): void {
    this.tenantGuard.release(tenantId);
    this.globalGuard.release(tenantId);
  }
}
