/**
 * Stage 4 finding 3 - a real run showed a per-call TIMEOUT/UNAVAILABLE
 * stall can repeat for many consecutive calls in a row, well past what a
 * single run's own deadline/retry budget should have to absorb. This
 * breaker lives INSIDE GeminiLlmProvider (one instance per process, since
 * GeminiLlmProvider is itself a process-wide singleton) and short-circuits
 * generate() entirely - no network call at all - once the upstream has
 * shown K consecutive availability failures, for a cooldown period, then
 * allows exactly one trial call to decide whether to close again.
 *
 * Deliberately narrow: only TIMEOUT and UNAVAILABLE (which already covers
 * a raw 503 - see throttled-gemini-client.ts's classifyError) count
 * toward the threshold. Everything else (a real success, RATE_LIMITED,
 * INVALID_OUTPUT, INVALID_INPUT, UNAUTHORIZED, ...) resets the consecutive
 * count without ever opening the breaker on its own - those are evidence
 * the server IS responding, just not always successfully, which is a
 * different problem this breaker is not trying to solve.
 */
export type CircuitBreakerState = 'closed' | 'open' | 'half_open';

export interface CircuitBreakerSettings {
  /** K - consecutive availability failures (closed state) before opening. */
  failureThreshold: number;
  /** How long the breaker stays open before allowing one half-open trial call. */
  cooldownMs: number;
}

export class CircuitBreaker {
  private state: CircuitBreakerState = 'closed';
  private consecutiveFailures = 0;
  private openedAt = 0;

  constructor(
    private readonly settings: CircuitBreakerSettings,
    private readonly clock: () => Date,
    /** Fires only on a real state change - never called for a no-op "transition" to the same state. Counts/states only, matching this project's own logging discipline - never pass prompt/response text through here. */
    private readonly onTransition?: (from: CircuitBreakerState, to: CircuitBreakerState) => void,
  ) {}

  getState(): CircuitBreakerState {
    return this.state;
  }

  /**
   * Call once, synchronously, before attempting a real network call.
   * 'reject' means: do not call the network at all, return CIRCUIT_OPEN
   * immediately. A caller that gets 'allow' from the open->half_open
   * transition MUST call recordOutcome() exactly once when that one trial
   * call finishes - that result decides close vs reopen.
   */
  beforeCall(): 'allow' | 'reject' {
    if (this.state === 'closed') {
      return 'allow';
    }
    if (this.state === 'half_open') {
      // The one half-open trial slot is already in use - never allow a
      // second concurrent trial call while the first hasn't resolved yet.
      return 'reject';
    }
    // open
    if (this.clock().getTime() - this.openedAt >= this.settings.cooldownMs) {
      this.setState('half_open');
      return 'allow';
    }
    return 'reject';
  }

  /**
   * Call once after a real call beforeCall() allowed actually completed.
   * `isAvailabilityFailure` - true only for TIMEOUT/UNAVAILABLE, see this
   * file's own top comment for why everything else is treated as "the
   * server is responding" regardless of whether the call itself succeeded.
   */
  recordOutcome(isAvailabilityFailure: boolean): void {
    if (this.state === 'half_open') {
      if (isAvailabilityFailure) {
        // The trial failed the same way - reopen, reset the cooldown clock.
        this.setState('open');
        this.openedAt = this.clock().getTime();
      } else {
        // The trial got a real response (success or not) - the server is
        // responsive again, close and reset the failure count.
        this.consecutiveFailures = 0;
        this.setState('closed');
      }
      return;
    }
    // closed (recordOutcome is never meaningfully called while 'open' -
    // beforeCall() would have rejected before any real call happened).
    if (!isAvailabilityFailure) {
      this.consecutiveFailures = 0;
      return;
    }
    this.consecutiveFailures += 1;
    if (this.consecutiveFailures >= this.settings.failureThreshold) {
      this.setState('open');
      this.openedAt = this.clock().getTime();
    }
  }

  private setState(next: CircuitBreakerState): void {
    if (next === this.state) {
      return;
    }
    const from = this.state;
    this.state = next;
    this.onTransition?.(from, next);
  }
}
