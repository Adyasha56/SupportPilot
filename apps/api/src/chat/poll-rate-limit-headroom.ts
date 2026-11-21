/**
 * Milestone 5, Stage 1a/1b follow-up (Part 0, item P1) - the documented
 * widget polling policy as a pure, computable model. The accompanying spec
 * uses this to PROVE, against the real `ChatSettings` defaults, that
 * realistic polling traffic leaves real headroom under every limiter it
 * passes through: the per-conversation bucket, the NEW per-tenant poll
 * bucket, and the NEW poll-dedicated per-IP/per-API-key guard buckets
 * (poll-api-key-guard.ts) - which, after this fix, are no longer shared
 * with chat-sending traffic at all.
 *
 * Cadence REVISED from the original Stage 1a draft (3s/10s) to a cheaper
 * one (5s start, back off to 15s after the first 30s, stop after 10
 * minutes) specifically because Part 0's audit found the original numbers
 * were sized assuming ONE visitor, never checked against realistic
 * concurrency - see `ASSUMED_CONCURRENT_VISITORS` below for the number
 * this file now sizes every bucket against instead.
 *
 * This is a deliberate substitute for a real-time (or artificially
 * time-compressed) HTTP integration test: `ApiKeyGuard` hardcodes its own
 * `() => new Date()` clock (no injectable clock, unlike every chat-layer
 * limiter), so there is no way to drive a real 10-minute polling scenario
 * through it inside an actual test run without either taking 10 real
 * minutes or faking a clock it doesn't accept. A closed-form worst-case
 * calculation against the real settings is a stronger, deterministic
 * guarantee than a flaky scaled-down timer-based simulation would be.
 */
export interface PollCadencePolicy {
  burstIntervalMs: number;
  burstDurationMs: number;
  steadyIntervalMs: number;
  stopAfterMs: number;
}

export const DOCUMENTED_POLL_CADENCE: PollCadencePolicy = {
  burstIntervalMs: 5_000,
  burstDurationMs: 30_000,
  steadyIntervalMs: 15_000,
  stopAfterMs: 600_000,
};

/**
 * The concurrency assumption every multi-visitor bucket default (the
 * pollGuardIp, pollGuardApiKey, and pollTenant settings in chat.settings.ts)
 * is sized against - a stated number, not an unbounded "as many as show
 * up". 20 is
 * a deliberately round, generous number for this project's actual scale (a
 * portfolio demo, not a high-traffic production tenant) - PROJECT.md's own
 * non-goal is "a hosted, many-customer production deployment". A tenant
 * that genuinely expects more than 20 concurrent widget visitors polling
 * at once should raise these settings explicitly, not rely on an unstated
 * default scaling automatically.
 */
export const ASSUMED_CONCURRENT_VISITORS = 20;

/**
 * The worst-case total request count across `concurrentVisitors`
 * independent pollers, assuming every one of them is - worst case -
 * perfectly phase-aligned (all started polling at the exact same instant).
 * Real visitors start their own polling loop at independent, unsynchronized
 * times, so this is a deliberately PESSIMISTIC (safe-to-size-against, not
 * a realistic expectation) upper bound: true concurrent load is spread
 * across staggered phases and is almost always lower than this number in
 * practice. Stated here explicitly as the assumption it is, not hidden
 * inside a single "looks about right" constant.
 */
export function maxRequestsInWindowForConcurrentVisitors(timestamps: number[], windowMs: number, concurrentVisitors: number): number {
  return maxRequestsInWindow(timestamps, windowMs) * concurrentVisitors;
}

/** Every request timestamp (ms since the triggering event) the documented cadence would ever produce. */
export function pollRequestTimestamps(policy: PollCadencePolicy): number[] {
  const timestamps: number[] = [];
  for (let t = policy.burstIntervalMs; t <= policy.burstDurationMs; t += policy.burstIntervalMs) {
    timestamps.push(t);
  }
  for (let t = policy.burstDurationMs + policy.steadyIntervalMs; t <= policy.stopAfterMs; t += policy.steadyIntervalMs) {
    timestamps.push(t);
  }
  return timestamps;
}

/**
 * The maximum number of timestamps falling within ANY window of length
 * `windowMs`, sliding across the whole sequence. Only needs to check a
 * window whose RIGHT edge lands exactly on an existing timestamp - shifting
 * the right edge to anywhere between two points can only ever match the
 * same or fewer points than aligning it with the later one, so the true
 * maximum is always achieved at one of the actual data points. O(n^2),
 * fine for the few dozen points this policy ever produces.
 */
export function maxRequestsInWindow(timestamps: number[], windowMs: number): number {
  let max = 0;
  for (const end of timestamps) {
    const start = end - windowMs;
    const count = timestamps.filter((t) => t > start && t <= end).length;
    max = Math.max(max, count);
  }
  return max;
}
