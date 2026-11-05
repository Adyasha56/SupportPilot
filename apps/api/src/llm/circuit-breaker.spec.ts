import { describe, expect, it } from 'vitest';
import { CircuitBreaker, CircuitBreakerState } from './circuit-breaker';

function makeBreaker(overrides: { failureThreshold?: number; cooldownMs?: number } = {}) {
  let now = 0;
  const clock = () => new Date(now);
  const advance = (ms: number) => {
    now += ms;
  };
  const transitions: Array<{ from: CircuitBreakerState; to: CircuitBreakerState }> = [];
  const breaker = new CircuitBreaker(
    { failureThreshold: overrides.failureThreshold ?? 3, cooldownMs: overrides.cooldownMs ?? 60_000 },
    clock,
    (from, to) => transitions.push({ from, to }),
  );
  return { breaker, advance, transitions };
}

describe('CircuitBreaker', () => {
  it('starts closed, always allows', () => {
    const { breaker } = makeBreaker();
    expect(breaker.getState()).toBe('closed');
    expect(breaker.beforeCall()).toBe('allow');
  });

  it('stays closed through fewer than K consecutive availability failures', () => {
    const { breaker } = makeBreaker({ failureThreshold: 3 });
    expect(breaker.beforeCall()).toBe('allow');
    breaker.recordOutcome(true);
    expect(breaker.beforeCall()).toBe('allow');
    breaker.recordOutcome(true);
    expect(breaker.getState()).toBe('closed');
  });

  it('opens after exactly K consecutive availability failures', () => {
    const { breaker, transitions } = makeBreaker({ failureThreshold: 3 });
    for (let i = 0; i < 3; i++) {
      expect(breaker.beforeCall()).toBe('allow');
      breaker.recordOutcome(true);
    }
    expect(breaker.getState()).toBe('open');
    expect(transitions).toEqual([{ from: 'closed', to: 'open' }]);
  });

  it('a non-availability outcome resets the consecutive count without opening', () => {
    const { breaker } = makeBreaker({ failureThreshold: 3 });
    breaker.recordOutcome(true);
    breaker.recordOutcome(true);
    breaker.recordOutcome(false); // e.g. a real success, or RATE_LIMITED - resets
    breaker.recordOutcome(true);
    breaker.recordOutcome(true);
    expect(breaker.getState()).toBe('closed'); // only 2 consecutive again, not 4
  });

  it('while open, rejects immediately without ever calling the clock-dependent cooldown logic incorrectly - still within cooldown', () => {
    const { breaker } = makeBreaker({ failureThreshold: 1, cooldownMs: 60_000 });
    breaker.recordOutcome(true); // opens
    expect(breaker.getState()).toBe('open');
    expect(breaker.beforeCall()).toBe('reject');
    expect(breaker.beforeCall()).toBe('reject'); // repeated rejects, no state change
  });

  it('after the cooldown elapses, transitions to half_open and allows exactly one trial', () => {
    const { breaker, advance, transitions } = makeBreaker({ failureThreshold: 1, cooldownMs: 60_000 });
    breaker.recordOutcome(true); // opens
    advance(59_999);
    expect(breaker.beforeCall()).toBe('reject'); // not quite yet
    advance(1);
    expect(breaker.beforeCall()).toBe('allow'); // cooldown elapsed - half-open trial
    expect(breaker.getState()).toBe('half_open');
    expect(transitions).toEqual([
      { from: 'closed', to: 'open' },
      { from: 'open', to: 'half_open' },
    ]);
  });

  it('a second concurrent attempt while half-open is rejected - only one trial slot', () => {
    const { breaker, advance } = makeBreaker({ failureThreshold: 1, cooldownMs: 1000 });
    breaker.recordOutcome(true);
    advance(1000);
    expect(breaker.beforeCall()).toBe('allow'); // the one trial
    expect(breaker.beforeCall()).toBe('reject'); // a concurrent second attempt
  });

  it('a successful half-open trial closes the breaker and resets the failure count', () => {
    const { breaker, advance, transitions } = makeBreaker({ failureThreshold: 2, cooldownMs: 1000 });
    breaker.recordOutcome(true);
    breaker.recordOutcome(true); // opens
    advance(1000);
    breaker.beforeCall(); // half-open trial starts
    breaker.recordOutcome(false); // trial succeeds (or at least isn't an availability failure)
    expect(breaker.getState()).toBe('closed');
    expect(transitions).toEqual([
      { from: 'closed', to: 'open' },
      { from: 'open', to: 'half_open' },
      { from: 'half_open', to: 'closed' },
    ]);
    // Confirms the failure count was really reset, not just the state:
    expect(breaker.beforeCall()).toBe('allow');
    breaker.recordOutcome(true);
    expect(breaker.getState()).toBe('closed'); // 1 failure, threshold is 2
  });

  it('a failed half-open trial reopens the breaker and resets the cooldown clock', () => {
    const { breaker, advance, transitions } = makeBreaker({ failureThreshold: 1, cooldownMs: 1000 });
    breaker.recordOutcome(true); // opens at t=0
    advance(1000); // t=1000, cooldown elapsed
    breaker.beforeCall(); // half-open trial starts
    breaker.recordOutcome(true); // trial fails the same way
    expect(breaker.getState()).toBe('open');
    expect(transitions).toEqual([
      { from: 'closed', to: 'open' },
      { from: 'open', to: 'half_open' },
      { from: 'half_open', to: 'open' },
    ]);
    // Cooldown clock was reset - not yet elapsed again at the old deadline.
    expect(breaker.beforeCall()).toBe('reject');
    advance(999);
    expect(breaker.beforeCall()).toBe('reject');
    advance(1);
    expect(breaker.beforeCall()).toBe('allow');
  });

  it('onTransition is never called for a no-op "transition" to the same state', () => {
    const { breaker, transitions } = makeBreaker({ failureThreshold: 5 });
    breaker.recordOutcome(false);
    breaker.recordOutcome(false);
    breaker.recordOutcome(true);
    expect(transitions).toEqual([]);
  });
});
