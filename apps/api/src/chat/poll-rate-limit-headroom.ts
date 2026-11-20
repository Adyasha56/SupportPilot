/**
 * Milestone 5, Stage 1a, amendment A6/item 6 - the documented widget
 * polling policy (PROJECT.md's Milestone 5 handoff note: 3s cadence for the
 * first 30s, back off to 10s, stop after 10 minutes) as a pure, computable
 * model. The accompanying spec uses this to PROVE, against the real
 * `ChatSettings` defaults, that realistic polling traffic leaves real
 * headroom under the shared per-IP/per-API-key guard-level limiter
 * (ApiKeyGuard) this endpoint deliberately shares with POST /v1/chat.
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
  burstIntervalMs: 3_000,
  burstDurationMs: 30_000,
  steadyIntervalMs: 10_000,
  stopAfterMs: 600_000,
};

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
