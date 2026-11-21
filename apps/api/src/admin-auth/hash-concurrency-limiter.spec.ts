import { describe, expect, it } from 'vitest';
import { HashConcurrencyLimiter } from './password-hash';

/** Deliberately uses plain controllable promises, never real scrypt - this file tests the CAP/QUEUE mechanics in isolation, fast and deterministically. */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe('HashConcurrencyLimiter (item 2 - concurrency cap + bounded queue)', () => {
  it('runs up to maxConcurrency jobs immediately, in parallel', async () => {
    const limiter = new HashConcurrencyLimiter(2, 10);
    const a = deferred<string>();
    const b = deferred<string>();

    const p1 = limiter.run(() => a.promise);
    const p2 = limiter.run(() => b.promise);
    // Both should be in flight now, neither queued.
    await new Promise((r) => setTimeout(r, 10));
    expect(limiter.snapshot).toEqual({ inFlight: 2, queued: 0 });

    a.resolve('a');
    b.resolve('b');
    expect(await p1).toEqual({ ok: true, value: 'a' });
    expect(await p2).toEqual({ ok: true, value: 'b' });
  });

  it('queues a job beyond maxConcurrency and runs it once a slot frees up', async () => {
    const limiter = new HashConcurrencyLimiter(1, 10);
    const a = deferred<string>();
    const b = deferred<string>();

    const p1 = limiter.run(() => a.promise);
    await new Promise((r) => setTimeout(r, 10));
    const p2 = limiter.run(() => b.promise);
    await new Promise((r) => setTimeout(r, 10));
    expect(limiter.snapshot).toEqual({ inFlight: 1, queued: 1 });

    a.resolve('a');
    expect(await p1).toEqual({ ok: true, value: 'a' });
    await new Promise((r) => setTimeout(r, 10));
    expect(limiter.snapshot.inFlight).toBe(1); // b's job picked up the freed slot

    b.resolve('b');
    expect(await p2).toEqual({ ok: true, value: 'b' });
  });

  it('rejects immediately with {ok:false} once the queue itself is full - never queues past the cap', async () => {
    const limiter = new HashConcurrencyLimiter(1, 1);
    const a = deferred<string>();
    const b = deferred<string>();

    const p1 = limiter.run(() => a.promise); // occupies the one concurrency slot
    await new Promise((r) => setTimeout(r, 10));
    const p2 = limiter.run(() => b.promise); // fills the one queue slot
    await new Promise((r) => setTimeout(r, 10));

    const rejected = await limiter.run(() => Promise.resolve('never runs'));
    expect(rejected).toEqual({ ok: false });

    a.resolve('a');
    await p1;
    b.resolve('b');
    await p2;
  });

  it('a queued job that eventually runs can still fail without corrupting the limiter state for the next one', async () => {
    const limiter = new HashConcurrencyLimiter(1, 10);
    const first = await limiter.run(() => Promise.reject(new Error('boom'))).catch((e) => e);
    expect(first).toBeInstanceOf(Error);
    const second = await limiter.run(() => Promise.resolve('ok'));
    expect(second).toEqual({ ok: true, value: 'ok' });
    expect(limiter.snapshot).toEqual({ inFlight: 0, queued: 0 });
  });
});
