import { Controller, Get, INestApplication, Req } from '@nestjs/common';
import { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import type { Request } from 'express';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { RateLimiter } from './rate-limiter';

function makeClock(startMs: number): { clock: () => Date; advance: (ms: number) => void } {
  let now = startMs;
  return { clock: () => new Date(now), advance: (ms) => (now += ms) };
}

describe('RateLimiter', () => {
  it('allows up to maxRequests within the window, then denies with a positive retryAfterMs', () => {
    const { clock } = makeClock(0);
    const limiter = new RateLimiter({ maxRequests: 3, windowMs: 60_000, maxEntries: 100 }, clock);

    expect(limiter.tryConsume('a')).toEqual({ allowed: true });
    expect(limiter.tryConsume('a')).toEqual({ allowed: true });
    expect(limiter.tryConsume('a')).toEqual({ allowed: true });

    const decision = limiter.tryConsume('a');
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) {
      expect(decision.retryAfterMs).toBeGreaterThan(0);
      expect(decision.retryAfterMs).toBeLessThanOrEqual(60_000);
    }
  });

  it('allows a request again once the oldest timestamp falls out of the window', () => {
    const { clock, advance } = makeClock(0);
    const limiter = new RateLimiter({ maxRequests: 1, windowMs: 1000, maxEntries: 100 }, clock);

    expect(limiter.tryConsume('a')).toEqual({ allowed: true });
    expect(limiter.tryConsume('a').allowed).toBe(false);

    advance(1000);
    expect(limiter.tryConsume('a')).toEqual({ allowed: true });
  });

  it('keeps separate, independent counts per key', () => {
    const { clock } = makeClock(0);
    const limiter = new RateLimiter({ maxRequests: 1, windowMs: 60_000, maxEntries: 100 }, clock);

    expect(limiter.tryConsume('a')).toEqual({ allowed: true });
    expect(limiter.tryConsume('a').allowed).toBe(false);
    expect(limiter.tryConsume('b')).toEqual({ allowed: true }); // a different key, unaffected
  });

  it('two separate RateLimiter instances never share state - the shape each "bucket" (IP/key/tenant/customerRef) needs', () => {
    const { clock } = makeClock(0);
    const ipLimiter = new RateLimiter({ maxRequests: 1, windowMs: 60_000, maxEntries: 100 }, clock);
    const tenantLimiter = new RateLimiter({ maxRequests: 1, windowMs: 60_000, maxEntries: 100 }, clock);

    expect(ipLimiter.tryConsume('same-key')).toEqual({ allowed: true });
    // Same string key, a completely different limiter instance - still allowed.
    expect(tenantLimiter.tryConsume('same-key')).toEqual({ allowed: true });
  });

  it('a flood of distinct keys cannot grow memory without bound - caps at maxEntries via oldest-insertion eviction', () => {
    const { clock } = makeClock(0);
    const limiter = new RateLimiter({ maxRequests: 10, windowMs: 60_000, maxEntries: 3 }, clock);

    limiter.tryConsume('key1');
    limiter.tryConsume('key2');
    limiter.tryConsume('key3');
    limiter.tryConsume('key4'); // evicts key1

    // key1 was evicted, so it gets a completely fresh bucket - still allowed,
    // which is the observable proof eviction happened (bucket count never exceeded maxEntries).
    for (let i = 0; i < 10; i++) {
      expect(limiter.tryConsume('key1').allowed).toBe(true);
    }
    // key2/key3/key4 are unaffected by key1's churn.
    expect(limiter.tryConsume('key4').allowed).toBe(true);
  });

  it('retryAfterMs reflects an injected clock, not the real wall clock', () => {
    const { clock, advance } = makeClock(1_000_000);
    const limiter = new RateLimiter({ maxRequests: 1, windowMs: 10_000, maxEntries: 10 }, clock);

    limiter.tryConsume('a');
    advance(4_000);
    const decision = limiter.tryConsume('a');

    expect(decision.allowed).toBe(false);
    if (!decision.allowed) {
      expect(decision.retryAfterMs).toBe(6_000);
    }
  });
});

// --- Client IP resolution honors the existing trust-proxy setting only ----

@Controller('test')
class RateLimitedIpController {
  private readonly limiter = new RateLimiter({ maxRequests: 1, windowMs: 60_000, maxEntries: 100 }, () => new Date());

  @Get('limited')
  hit(@Req() req: Request): { allowed: boolean; ip: string } {
    const ip = req.ip ?? 'unknown';
    return { allowed: this.limiter.tryConsume(ip).allowed, ip };
  }
}

async function buildApp(trustProxyHops: number): Promise<INestApplication> {
  const moduleRef = await Test.createTestingModule({ controllers: [RateLimitedIpController] }).compile();
  const app = moduleRef.createNestApplication<NestExpressApplication>();
  app.set('trust proxy', trustProxyHops);
  await app.init();
  return app;
}

describe('RateLimiter keyed by req.ip, under the real trust-proxy setting', () => {
  let app: INestApplication | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it('at 0 hops (the default), a spoofed X-Forwarded-For cannot be used to get a fresh rate-limit bucket', async () => {
    app = await buildApp(0);
    const agent = request(app.getHttpServer());

    const first = await agent.get('/test/limited').set('X-Forwarded-For', '203.0.113.1');
    expect(first.body.allowed).toBe(true);

    // Same real connection, a DIFFERENT spoofed X-Forwarded-For - at 0 hops
    // this must resolve to the same real socket IP, so the second request
    // against the already-exhausted bucket is denied, not a fresh one.
    const second = await agent.get('/test/limited').set('X-Forwarded-For', '203.0.113.2');
    expect(second.body.ip).toBe(first.body.ip); // the spoofed header never changed the resolved ip
    expect(second.body.allowed).toBe(false);
  });

  it('at 1 hop, a genuinely different X-Forwarded-For IS a different bucket (single-reverse-proxy deployment)', async () => {
    app = await buildApp(1);
    const agent = request(app.getHttpServer());

    const first = await agent.get('/test/limited').set('X-Forwarded-For', '203.0.113.10');
    expect(first.body).toEqual({ allowed: true, ip: '203.0.113.10' });

    const second = await agent.get('/test/limited').set('X-Forwarded-For', '203.0.113.11');
    expect(second.body).toEqual({ allowed: true, ip: '203.0.113.11' }); // a different client, its own fresh bucket
  });
});
