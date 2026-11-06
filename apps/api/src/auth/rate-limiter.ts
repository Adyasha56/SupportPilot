/**
 * A generic, bounded-memory, sliding-window request counter - same shape
 * as FailedAttemptLimiter (one Map, oldest-insertion eviction once at
 * capacity) but counts EVERY call, not just failures, and reports a
 * concrete Retry-After instead of a bare boolean. Single-process, in-memory
 * - the same accepted limitation as every other limiter/lock in this
 * project (TenantIngestionLock, FailedAttemptLimiter): fine at this
 * project's current scale, would need a shared store across instances.
 *
 * One instance per "bucket" (per-IP, per-API-key, per-tenant,
 * per-customerRef - Stage 4 amendment B) - this class has no concept of
 * which bucket it is; the caller wires up separate instances with
 * separate settings, so buckets can never share state just because they
 * happen to run in the same process.
 */
export interface RateLimiterSettings {
  maxRequests: number;
  windowMs: number;
  /** Caps total memory against many distinct keys (e.g. a flood from many distinct IPs), not just repeat hits from one key - same reasoning as FailedAttemptLimiter's own maxEntries. */
  maxEntries: number;
}

export type RateLimitDecision = { allowed: true } | { allowed: false; retryAfterMs: number };

export class RateLimiter {
  private readonly buckets = new Map<string, number[]>();

  constructor(
    private readonly settings: RateLimiterSettings,
    private readonly clock: () => Date,
  ) {}

  tryConsume(key: string): RateLimitDecision {
    const now = this.clock().getTime();
    let timestamps = this.buckets.get(key);

    if (!timestamps) {
      if (this.buckets.size >= this.settings.maxEntries) {
        const oldestKey = this.buckets.keys().next().value;
        if (oldestKey !== undefined) {
          this.buckets.delete(oldestKey);
        }
      }
      timestamps = [];
      this.buckets.set(key, timestamps);
    }

    while (timestamps.length > 0 && now - timestamps[0] >= this.settings.windowMs) {
      timestamps.shift();
    }

    if (timestamps.length >= this.settings.maxRequests) {
      const retryAfterMs = this.settings.windowMs - (now - timestamps[0]);
      return { allowed: false, retryAfterMs };
    }

    timestamps.push(now);
    return { allowed: true };
  }
}
