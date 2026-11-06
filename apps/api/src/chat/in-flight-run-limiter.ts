/**
 * Stage 4 amendment B - a global cap on concurrently-EXECUTING chat runs,
 * plus a small fixed extra allowance ("queued") above that hard target -
 * beyond the combined total, a caller gets 429 immediately. Deliberately
 * NOT a real waiting queue: there is no deferred execution here at all,
 * no timer, no promise that resolves later when a slot frees. A caller
 * either gets a slot right now (reserved up to maxInFlight + maxQueued) or
 * is rejected right now - "instead of queueing until the [agent] deadline"
 * is the explicit instruction this satisfies: a rejected request never
 * sits around hoping a slot frees before some later timeout fires.
 *
 * `maxQueued` exists only as a small burst-smoothing margin above the real
 * target concurrency (maxInFlight) - e.g. several requests landing in the
 * same tick when the true comfortable concurrency is 3. It is not a
 * promise of eventual admission.
 *
 * CAPACITY MATH (documented here since this is the class the numbers are
 * chosen against): this project's configured GEMINI_GENERATE_RPM default
 * is 10, and a chat run makes 2 real generate() calls in the normal case
 * (plan + compose), so the SUSTAINED throughput ceiling this whole system
 * can support is bounded by Gemini's own RPM, not by maxInFlight: roughly
 * 10 RPM / 2 calls-per-run = 5 completed runs/minute (~1 every 12s) under
 * ideal conditions, not 3. Setting maxInFlight to 3 does NOT, by itself,
 * guarantee the RPM budget is respected - ThrottledClient's own internal
 * queueing (apps/api/src/llm/throttled-gemini-client.ts) absorbs demand
 * above that ceiling by making individual generate() calls wait for a
 * rate-limit slot, which under sustained overload shows up as longer run
 * latency (toward AGENT_TOTAL_DEADLINE_MS) rather than an outright
 * rejection. maxInFlight's real job is bounding concurrent memory/socket
 * use and giving a fast, honest 429 under a REQUEST flood (many requests
 * arriving close together), not capacity-planning the RPM budget - a
 * free-tier, low-traffic demo is expected to run far below either ceiling
 * in practice.
 */
export interface InFlightRunLimiterSettings {
  maxInFlight: number;
  maxQueued: number;
  /** What to tell a rejected caller - there is no real queue position to compute a precise value from, so this is a fixed, configurable estimate. */
  retryAfterSeconds: number;
}

export type InFlightEnterResult = { allowed: true; release: () => void } | { allowed: false; retryAfterSeconds: number };

export class InFlightRunLimiter {
  private active = 0;

  constructor(private readonly settings: InFlightRunLimiterSettings) {}

  tryEnter(): InFlightEnterResult {
    if (this.active >= this.settings.maxInFlight + this.settings.maxQueued) {
      return { allowed: false, retryAfterSeconds: this.settings.retryAfterSeconds };
    }

    this.active += 1;
    let released = false;
    return {
      allowed: true,
      release: () => {
        if (released) {
          return;
        }
        released = true;
        this.active -= 1;
      },
    };
  }

  /** Diagnostics/tests only. */
  get activeCount(): number {
    return this.active;
  }
}
