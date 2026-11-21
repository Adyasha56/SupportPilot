/**
 * Milestone 5, Stage 1b, item 3 - a pure function, no I/O, no clock of its
 * own (the caller always passes `now` - admin-login.service.ts's own
 * injected clock). The first `freeAttempts` failures lock for 0ms (an
 * ordinary wrong-password response, no lockout yet - a genuine typo
 * shouldn't immediately cost the user a wait); every failure after that
 * locks for `baseMs * 2^(failedAttempts - freeAttempts - 1)`, capped at
 * `capMs` - so the backoff schedule with the default settings
 * (freeAttempts=3, baseMs=1000, capMs=900000) is: attempts 1-3 -> 0ms,
 * attempt 4 -> 1s, 5 -> 2s, 6 -> 4s, 7 -> 8s, ... reaching the 15-minute
 * cap around attempt 13 and staying there for every attempt after.
 */
export function computeLockoutMs(failedAttempts: number, settings: { freeAttempts: number; baseMs: number; capMs: number }): number {
  if (failedAttempts <= settings.freeAttempts) {
    return 0;
  }
  const exponent = failedAttempts - settings.freeAttempts - 1;
  // 2^exponent can overflow to Infinity for a very large failedAttempts (never realistically
  // reached, but Math.min below still handles it correctly - Infinity > capMs).
  const uncapped = settings.baseMs * Math.pow(2, exponent);
  return Math.min(uncapped, settings.capMs);
}

/** `lockedUntil` to persist on the credential right after recording this failure - `now` plus the schedule's own duration (0 means "not locked", same as leaving lockedUntil null). */
export function computeLockedUntil(failedAttempts: number, now: Date, settings: { freeAttempts: number; baseMs: number; capMs: number }): Date | null {
  const ms = computeLockoutMs(failedAttempts, settings);
  return ms > 0 ? new Date(now.getTime() + ms) : null;
}
