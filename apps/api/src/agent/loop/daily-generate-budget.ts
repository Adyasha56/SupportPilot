export interface DailyGenerateBudgetGuard {
  /** Returns true and consumes one ticket if the budget allows it this call; returns false (consumes nothing) otherwise. */
  tryConsume(): boolean;
  /**
   * Stage 4 finding 3 - refunds one previously-consumed ticket. Used only
   * when a ticket was consumed but generate() then returned CIRCUIT_OPEN
   * (no real Gemini call happened, so nothing was really spent) - never
   * used for any other error code, since every other failure DID reach the
   * real API and genuinely counts against the day's budget.
   */
  release(): void;
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

  tryConsume(): boolean {
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

  release(): void {
    if (this.count > 0) {
      this.count -= 1;
    }
  }
}
