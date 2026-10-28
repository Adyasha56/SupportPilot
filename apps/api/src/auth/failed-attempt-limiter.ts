/**
 * Small in-memory per-key (IP) failed-attempt limiter, no new dependency.
 *
 * Proposed rather than deferred: implementing it is cheap (one Map, no
 * external state), and while a 256-bit random key makes brute force
 * cryptographically meaningless regardless of rate limiting, this still
 * protects against resource exhaustion and log noise from a misbehaving or
 * hammering client - a reasonable guardrail even though it's not the thing
 * actually keeping the key space safe. Single-process, in-memory state is
 * fine at this project's current scale (one instance, free tier); would
 * need a shared store (e.g. Redis) if ever running multiple instances.
 */
export class FailedAttemptLimiter {
  private readonly attempts = new Map<string, { count: number; windowStart: number }>();

  constructor(
    private readonly maxAttempts = 10,
    private readonly windowMs = 60_000,
    // Caps total memory use against many distinct keys (e.g. a scan from many
    // source IPs each failing once), not just repeat hits from one key - the
    // windowMs expiry alone only reclaims an entry the next time THAT SAME
    // key is looked up, so a key that's never queried again would otherwise
    // sit in the Map forever. A Map preserves insertion order, so "oldest"
    // here means oldest-inserted, which is a reasonable eviction choice
    // without adding a second data structure or a background sweep timer.
    private readonly maxEntries = 5000,
  ) {}

  isBlocked(key: string): boolean {
    const entry = this.attempts.get(key);
    if (!entry) {
      return false;
    }
    if (Date.now() - entry.windowStart > this.windowMs) {
      this.attempts.delete(key);
      return false;
    }
    return entry.count >= this.maxAttempts;
  }

  recordFailure(key: string): void {
    const now = Date.now();
    const entry = this.attempts.get(key);
    if (!entry || now - entry.windowStart > this.windowMs) {
      if (!this.attempts.has(key) && this.attempts.size >= this.maxEntries) {
        const oldestKey = this.attempts.keys().next().value;
        if (oldestKey !== undefined) {
          this.attempts.delete(oldestKey);
        }
      }
      this.attempts.set(key, { count: 1, windowStart: now });
      return;
    }
    entry.count += 1;
  }

  recordSuccess(key: string): void {
    this.attempts.delete(key);
  }
}
