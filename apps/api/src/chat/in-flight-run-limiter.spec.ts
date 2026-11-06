import { describe, expect, it } from 'vitest';
import { InFlightRunLimiter } from './in-flight-run-limiter';

describe('InFlightRunLimiter', () => {
  it('allows entry up to maxInFlight + maxQueued, then rejects immediately with a retryAfterSeconds', () => {
    const limiter = new InFlightRunLimiter({ maxInFlight: 2, maxQueued: 1, retryAfterSeconds: 5 });

    expect(limiter.tryEnter().allowed).toBe(true);
    expect(limiter.tryEnter().allowed).toBe(true);
    expect(limiter.tryEnter().allowed).toBe(true); // within the extra "queued" allowance

    const result = limiter.tryEnter();
    expect(result).toEqual({ allowed: false, retryAfterSeconds: 5 });
  });

  it('never actually waits - a rejection is synchronous and immediate, no deferred admission', () => {
    const limiter = new InFlightRunLimiter({ maxInFlight: 1, maxQueued: 0, retryAfterSeconds: 3 });
    limiter.tryEnter();

    const result = limiter.tryEnter();
    expect(result.allowed).toBe(false); // returned right away, not a pending promise
  });

  it('release() frees a slot so a subsequent caller can enter', () => {
    const limiter = new InFlightRunLimiter({ maxInFlight: 1, maxQueued: 0, retryAfterSeconds: 3 });
    const first = limiter.tryEnter();
    expect(first.allowed).toBe(true);
    expect(limiter.tryEnter().allowed).toBe(false);

    if (first.allowed) {
      first.release();
    }

    expect(limiter.tryEnter().allowed).toBe(true);
  });

  it('release() is idempotent - calling it twice never frees two slots', () => {
    const limiter = new InFlightRunLimiter({ maxInFlight: 1, maxQueued: 0, retryAfterSeconds: 3 });
    const first = limiter.tryEnter();

    if (first.allowed) {
      first.release();
      first.release(); // second call is a no-op
    }

    expect(limiter.activeCount).toBe(0);
  });

  it('tracks activeCount accurately across enter/release cycles', () => {
    const limiter = new InFlightRunLimiter({ maxInFlight: 3, maxQueued: 2, retryAfterSeconds: 1 });
    const a = limiter.tryEnter();
    const b = limiter.tryEnter();
    expect(limiter.activeCount).toBe(2);

    if (a.allowed) a.release();
    expect(limiter.activeCount).toBe(1);

    if (b.allowed) b.release();
    expect(limiter.activeCount).toBe(0);
  });
});
