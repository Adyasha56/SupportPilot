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
      this.attempts.set(key, { count: 1, windowStart: now });
      return;
    }
    entry.count += 1;
  }

  recordSuccess(key: string): void {
    this.attempts.delete(key);
  }
}
