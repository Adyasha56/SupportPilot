import { describe, expect, it } from 'vitest';
import { ConversationLock } from './conversation-lock';

function makeClock(startMs: number): { clock: () => Date; advance: (ms: number) => void } {
  let now = startMs;
  return { clock: () => new Date(now), advance: (ms) => (now += ms) };
}

describe('ConversationLock', () => {
  it('acquires a free conversation and returns a typed busy result for a second concurrent attempt', () => {
    const { clock } = makeClock(0);
    const lock = new ConversationLock({ ttlMs: 35_000, maxEntries: 100 }, clock);

    const first = lock.tryAcquire('conv_1');
    expect(first.acquired).toBe(true);

    const second = lock.tryAcquire('conv_1');
    expect(second).toEqual({ acquired: false });
  });

  it('release() lets a later request acquire the same conversation', () => {
    const { clock } = makeClock(0);
    const lock = new ConversationLock({ ttlMs: 35_000, maxEntries: 100 }, clock);

    const first = lock.tryAcquire('conv_1');
    expect(first.acquired).toBe(true);
    expect(lock.tryAcquire('conv_1').acquired).toBe(false);

    if (first.acquired) {
      first.release();
    }

    expect(lock.tryAcquire('conv_1').acquired).toBe(true);
  });

  it('release() is idempotent and never releases a DIFFERENT holder\'s later acquisition', () => {
    const { clock } = makeClock(0);
    const lock = new ConversationLock({ ttlMs: 35_000, maxEntries: 100 }, clock);

    const first = lock.tryAcquire('conv_1');
    if (first.acquired) {
      first.release();
    }
    const second = lock.tryAcquire('conv_1'); // a new holder
    expect(second.acquired).toBe(true);

    if (first.acquired) {
      first.release(); // stale release from the FIRST holder - must not affect the second holder's lock
    }

    expect(lock.tryAcquire('conv_1').acquired).toBe(false); // still held, by the second holder
  });

  it('a lock older than ttlMs is treated as stale and can be re-acquired (crash backstop)', () => {
    const { clock, advance } = makeClock(0);
    const lock = new ConversationLock({ ttlMs: 1000, maxEntries: 100 }, clock);

    lock.tryAcquire('conv_1'); // never released - simulates a crashed holder
    expect(lock.tryAcquire('conv_1').acquired).toBe(false);

    advance(1000);
    expect(lock.tryAcquire('conv_1').acquired).toBe(true);
  });

  it('bounds memory: a flood of distinct conversation ids never grows the lock past maxEntries', () => {
    const { clock } = makeClock(0);
    const lock = new ConversationLock({ ttlMs: 60_000, maxEntries: 2 }, clock);

    lock.tryAcquire('conv_1');
    lock.tryAcquire('conv_2');
    lock.tryAcquire('conv_3'); // evicts conv_1's entry

    // conv_1's entry was evicted, so it's treated as free again - the
    // observable proof eviction happened, without reaching into private state.
    expect(lock.tryAcquire('conv_1').acquired).toBe(true);
  });

  describe('deterministic concurrency, no real timers or sleeps', () => {
    /** Controls exactly when a simulated "run" completes, via manual resolve - proves ordering without any real timing dependency. */
    function makeGate(): { promise: Promise<void>; resolve: () => void } {
      let resolve!: () => void;
      const promise = new Promise<void>((r) => {
        resolve = r;
      });
      return { promise, resolve };
    }

    it('a second concurrent request for the same conversation is rejected while the first is still "running"', async () => {
      const { clock } = makeClock(0);
      const lock = new ConversationLock({ ttlMs: 35_000, maxEntries: 100 }, clock);
      const gate = makeGate();

      const firstAcquire = lock.tryAcquire('conv_1');
      expect(firstAcquire.acquired).toBe(true);

      const simulatedFirstRun = gate.promise.then(() => {
        if (firstAcquire.acquired) {
          firstAcquire.release();
        }
      });

      // The second request arrives while the first "run" is still pending (gate not yet resolved).
      expect(lock.tryAcquire('conv_1')).toEqual({ acquired: false });

      gate.resolve();
      await simulatedFirstRun;

      // Now that the first run finished and released, a fresh request succeeds.
      expect(lock.tryAcquire('conv_1').acquired).toBe(true);
    });

    it('an exception inside the run still releases the lock, when the caller uses try/finally', async () => {
      const { clock } = makeClock(0);
      const lock = new ConversationLock({ ttlMs: 35_000, maxEntries: 100 }, clock);

      async function simulateRun(shouldThrow: boolean): Promise<void> {
        const acquired = lock.tryAcquire('conv_1');
        if (!acquired.acquired) {
          throw new Error('lock busy');
        }
        try {
          if (shouldThrow) {
            throw new Error('simulated failure inside the agent run');
          }
        } finally {
          acquired.release();
        }
      }

      await expect(simulateRun(true)).rejects.toThrow('simulated failure inside the agent run');

      // Despite the thrown exception, release() ran in `finally` - the
      // conversation is free again for the next request.
      expect(lock.tryAcquire('conv_1').acquired).toBe(true);
    });
  });
});
