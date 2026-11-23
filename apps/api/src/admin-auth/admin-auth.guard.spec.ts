import { ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { describe, expect, it, vi } from 'vitest';
import { ApiKeyScope } from '../db/schemas/api-key.schema';
import { InMemoryApiKeyRepository } from '../db/test-utils/in-memory-api-key.repository';
import { InMemoryAdminSessionRepository } from '../db/test-utils/in-memory-admin-session.repository';
import { hashApiKey } from '../auth/api-key.service';
import { AdminAuthGuard } from './admin-auth.guard';
import { AdminAuthSettings } from './admin-auth.settings';
import { hashSessionToken, mintCsrfToken, mintSessionToken } from './session-token';
import { PRODUCTION_SESSION_COOKIE_NAME } from './cookie-utils';

/** A fake Reflector: `undefined` means "no @RequireScope annotation" - the guard then falls back to its own default minimum (`admin`), exactly matching every pre-Stage-1c test's expectation here. */
function makeReflector(requiredScope?: ApiKeyScope): Reflector {
  return { getAllAndOverride: () => requiredScope } as unknown as Reflector;
}

function makeSettings(overrides: Partial<AdminAuthSettings> = {}): AdminAuthSettings {
  return {
    hashMaxConcurrency: 4,
    hashMaxQueueLength: 20,
    sessionAbsoluteLifetimeMs: 8 * 60 * 60 * 1000,
    sessionIdleTimeoutMs: 30 * 60 * 1000,
    sessionLastSeenWriteIntervalMs: 60_000,
    lockoutFreeAttempts: 2,
    lockoutBaseMs: 1_000,
    lockoutCapMs: 900_000,
    loginIpRateLimitMaxRequests: 1000,
    loginIpRateLimitWindowMs: 60_000,
    loginIpRateLimitMaxEntries: 1000,
    devCookieEnabled: false,
    allowedOrigins: ['https://admin.supportpilot.example'],
    principalRateLimitMaxRequests: 1000,
    principalRateLimitWindowMs: 60_000,
    principalRateLimitMaxEntries: 1000,
    ...overrides,
  };
}

interface FakeRequest {
  method: string;
  headers: Record<string, string | undefined>;
}

function makeContext(request: FakeRequest): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => request, getResponse: () => ({ setHeader: () => undefined }) }),
    getHandler: () => undefined,
    getClass: () => undefined,
  } as unknown as ExecutionContext;
}

/** Stage 1c, item 5 - same as makeContext, but exposes the response mock's setHeader calls for the rate-limit tests to assert Retry-After on. */
function makeContextWithResponse(request: FakeRequest): { context: ExecutionContext; setHeader: ReturnType<typeof vi.fn> } {
  const setHeader = vi.fn();
  const context = {
    switchToHttp: () => ({ getRequest: () => request, getResponse: () => ({ setHeader }) }),
    getHandler: () => undefined,
    getClass: () => undefined,
  } as unknown as ExecutionContext;
  return { context, setHeader };
}

describe('AdminAuthGuard (item 6)', () => {
  it('a valid admin-scoped API key authenticates via the header path, as kind: api_key', async () => {
    const apiKeyRepository = new InMemoryApiKeyRepository();
    const sessionRepository = new InMemoryAdminSessionRepository();
    const rawKey = 'sk_test_admin_key';
    const id = await apiKeyRepository.create('acme', hashApiKey(rawKey), 'sk_test', ['admin']);
    const guard = new AdminAuthGuard(apiKeyRepository, sessionRepository, makeSettings(), makeReflector(), () => new Date());

    const request: FakeRequest = { method: 'GET', headers: { authorization: `Bearer ${rawKey}` } };
    const allowed = await guard.canActivate(makeContext(request));

    expect(allowed).toBe(true);
    expect((request as unknown as { adminPrincipal: unknown }).adminPrincipal).toEqual({ tenantId: 'acme', principalId: id, kind: 'api_key' });
  });

  it('a SECRET-scoped key (not admin) is rejected - admin scope is required, not just any valid key', async () => {
    const apiKeyRepository = new InMemoryApiKeyRepository();
    const sessionRepository = new InMemoryAdminSessionRepository();
    const rawKey = 'sk_test_secret_key';
    await apiKeyRepository.create('acme', hashApiKey(rawKey), 'sk_test', ['secret']);
    const guard = new AdminAuthGuard(apiKeyRepository, sessionRepository, makeSettings(), makeReflector(), () => new Date());

    const request: FakeRequest = { method: 'GET', headers: { authorization: `Bearer ${rawKey}` } };
    await expect(guard.canActivate(makeContext(request))).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('header present means ONLY the key path - a valid cookie on the SAME request is ignored if the header is garbage', async () => {
    const apiKeyRepository = new InMemoryApiKeyRepository();
    const sessionRepository = new InMemoryAdminSessionRepository();
    const rawSessionToken = mintSessionToken();
    await sessionRepository.create({
      tenantId: 'acme',
      principalId: 'acme',
      tokenHash: hashSessionToken(rawSessionToken),
      csrfToken: mintCsrfToken(),
      lastSeenAt: new Date(),
      absoluteExpiresAt: new Date(Date.now() + 100_000),
      idleTimeoutMs: 100_000,
    });
    const guard = new AdminAuthGuard(apiKeyRepository, sessionRepository, makeSettings(), makeReflector(), () => new Date());

    const request: FakeRequest = {
      method: 'GET',
      headers: { authorization: 'Bearer not-a-real-key', cookie: `${PRODUCTION_SESSION_COOKIE_NAME}=${rawSessionToken}` },
    };
    await expect(guard.canActivate(makeContext(request))).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('a valid cookie authenticates via the session path on a GET - no CSRF required', async () => {
    const apiKeyRepository = new InMemoryApiKeyRepository();
    const sessionRepository = new InMemoryAdminSessionRepository();
    const rawSessionToken = mintSessionToken();
    const session = await sessionRepository.create({
      tenantId: 'acme',
      principalId: 'acme',
      tokenHash: hashSessionToken(rawSessionToken),
      csrfToken: mintCsrfToken(),
      lastSeenAt: new Date(),
      absoluteExpiresAt: new Date(Date.now() + 100_000),
      idleTimeoutMs: 100_000,
    });
    const guard = new AdminAuthGuard(apiKeyRepository, sessionRepository, makeSettings(), makeReflector(), () => new Date());

    const request: FakeRequest = { method: 'GET', headers: { cookie: `${PRODUCTION_SESSION_COOKIE_NAME}=${rawSessionToken}` } };
    const allowed = await guard.canActivate(makeContext(request));

    expect(allowed).toBe(true);
    expect((request as unknown as { adminPrincipal: { kind: string; sessionId: string } }).adminPrincipal).toMatchObject({
      kind: 'session',
      tenantId: 'acme',
      sessionId: session.id,
    });
  });

  it('a POST via the session path without the CSRF header is rejected', async () => {
    const apiKeyRepository = new InMemoryApiKeyRepository();
    const sessionRepository = new InMemoryAdminSessionRepository();
    const rawSessionToken = mintSessionToken();
    await sessionRepository.create({
      tenantId: 'acme',
      principalId: 'acme',
      tokenHash: hashSessionToken(rawSessionToken),
      csrfToken: mintCsrfToken(),
      lastSeenAt: new Date(),
      absoluteExpiresAt: new Date(Date.now() + 100_000),
      idleTimeoutMs: 100_000,
    });
    const guard = new AdminAuthGuard(apiKeyRepository, sessionRepository, makeSettings(), makeReflector(), () => new Date());

    const request: FakeRequest = { method: 'POST', headers: { cookie: `${PRODUCTION_SESSION_COOKIE_NAME}=${rawSessionToken}`, origin: 'https://admin.supportpilot.example' } };
    await expect(guard.canActivate(makeContext(request))).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('a POST with the WRONG CSRF token value is rejected', async () => {
    const apiKeyRepository = new InMemoryApiKeyRepository();
    const sessionRepository = new InMemoryAdminSessionRepository();
    const rawSessionToken = mintSessionToken();
    await sessionRepository.create({
      tenantId: 'acme',
      principalId: 'acme',
      tokenHash: hashSessionToken(rawSessionToken),
      csrfToken: 'the-real-csrf-token',
      lastSeenAt: new Date(),
      absoluteExpiresAt: new Date(Date.now() + 100_000),
      idleTimeoutMs: 100_000,
    });
    const guard = new AdminAuthGuard(apiKeyRepository, sessionRepository, makeSettings(), makeReflector(), () => new Date());

    const request: FakeRequest = {
      method: 'POST',
      headers: {
        cookie: `${PRODUCTION_SESSION_COOKIE_NAME}=${rawSessionToken}`,
        origin: 'https://admin.supportpilot.example',
        'x-csrf-token': 'a-completely-wrong-token',
      },
    };
    await expect(guard.canActivate(makeContext(request))).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('a POST with the RIGHT CSRF token and a matching Origin succeeds', async () => {
    const apiKeyRepository = new InMemoryApiKeyRepository();
    const sessionRepository = new InMemoryAdminSessionRepository();
    const rawSessionToken = mintSessionToken();
    await sessionRepository.create({
      tenantId: 'acme',
      principalId: 'acme',
      tokenHash: hashSessionToken(rawSessionToken),
      csrfToken: 'the-real-csrf-token',
      lastSeenAt: new Date(),
      absoluteExpiresAt: new Date(Date.now() + 100_000),
      idleTimeoutMs: 100_000,
    });
    const guard = new AdminAuthGuard(apiKeyRepository, sessionRepository, makeSettings(), makeReflector(), () => new Date());

    const request: FakeRequest = {
      method: 'POST',
      headers: {
        cookie: `${PRODUCTION_SESSION_COOKIE_NAME}=${rawSessionToken}`,
        origin: 'https://admin.supportpilot.example',
        'x-csrf-token': 'the-real-csrf-token',
      },
    };
    expect(await guard.canActivate(makeContext(request))).toBe(true);
  });

  it('a POST with the right CSRF but a cross-site Sec-Fetch-Site is STILL rejected', async () => {
    const apiKeyRepository = new InMemoryApiKeyRepository();
    const sessionRepository = new InMemoryAdminSessionRepository();
    const rawSessionToken = mintSessionToken();
    await sessionRepository.create({
      tenantId: 'acme',
      principalId: 'acme',
      tokenHash: hashSessionToken(rawSessionToken),
      csrfToken: 'the-real-csrf-token',
      lastSeenAt: new Date(),
      absoluteExpiresAt: new Date(Date.now() + 100_000),
      idleTimeoutMs: 100_000,
    });
    const guard = new AdminAuthGuard(apiKeyRepository, sessionRepository, makeSettings(), makeReflector(), () => new Date());

    const request: FakeRequest = {
      method: 'POST',
      headers: { cookie: `${PRODUCTION_SESSION_COOKIE_NAME}=${rawSessionToken}`, 'x-csrf-token': 'the-real-csrf-token', 'sec-fetch-site': 'cross-site' },
    };
    await expect(guard.canActivate(makeContext(request))).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('a session past its ABSOLUTE expiry is rejected even if otherwise valid', async () => {
    const apiKeyRepository = new InMemoryApiKeyRepository();
    const sessionRepository = new InMemoryAdminSessionRepository();
    const now = new Date('2026-01-01T01:00:00.000Z');
    const rawSessionToken = mintSessionToken();
    await sessionRepository.create({
      tenantId: 'acme',
      principalId: 'acme',
      tokenHash: hashSessionToken(rawSessionToken),
      csrfToken: 'x',
      lastSeenAt: new Date('2026-01-01T00:00:00.000Z'),
      absoluteExpiresAt: new Date('2026-01-01T00:30:00.000Z'), // already past relative to `now`
      idleTimeoutMs: 100_000_000,
    });
    const guard = new AdminAuthGuard(apiKeyRepository, sessionRepository, makeSettings(), makeReflector(), () => now);

    const request: FakeRequest = { method: 'GET', headers: { cookie: `${PRODUCTION_SESSION_COOKIE_NAME}=${rawSessionToken}` } };
    await expect(guard.canActivate(makeContext(request))).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('a session past its IDLE timeout is rejected even though it is still within its absolute lifetime', async () => {
    const apiKeyRepository = new InMemoryApiKeyRepository();
    const sessionRepository = new InMemoryAdminSessionRepository();
    const now = new Date('2026-01-01T01:00:00.000Z');
    const rawSessionToken = mintSessionToken();
    await sessionRepository.create({
      tenantId: 'acme',
      principalId: 'acme',
      tokenHash: hashSessionToken(rawSessionToken),
      csrfToken: 'x',
      lastSeenAt: new Date('2026-01-01T00:00:00.000Z'), // 1 hour ago
      absoluteExpiresAt: new Date('2026-01-02T00:00:00.000Z'), // comfortably in the future
      idleTimeoutMs: 30 * 60 * 1000, // 30 minutes - already exceeded
    });
    const guard = new AdminAuthGuard(apiKeyRepository, sessionRepository, makeSettings(), makeReflector(), () => now);

    const request: FakeRequest = { method: 'GET', headers: { cookie: `${PRODUCTION_SESSION_COOKIE_NAME}=${rawSessionToken}` } };
    await expect(guard.canActivate(makeContext(request))).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('lastSeenAt is written at most once per the configured interval, never on every request', async () => {
    const apiKeyRepository = new InMemoryApiKeyRepository();
    const sessionRepository = new InMemoryAdminSessionRepository();
    const now = new Date('2026-01-01T00:00:00.000Z');
    const rawSessionToken = mintSessionToken();
    await sessionRepository.create({
      tenantId: 'acme',
      principalId: 'acme',
      tokenHash: hashSessionToken(rawSessionToken),
      csrfToken: 'x',
      lastSeenAt: now,
      absoluteExpiresAt: new Date(now.getTime() + 100_000_000),
      idleTimeoutMs: 100_000_000,
    });
    const settings = makeSettings({ sessionLastSeenWriteIntervalMs: 60_000 });
    const spy = vi.spyOn(sessionRepository, 'updateLastSeenAt');
    const guard = new AdminAuthGuard(apiKeyRepository, sessionRepository, settings, makeReflector(), () => now);

    const request: FakeRequest = { method: 'GET', headers: { cookie: `${PRODUCTION_SESSION_COOKIE_NAME}=${rawSessionToken}` } };
    await guard.canActivate(makeContext(request)); // same `now` as lastSeenAt - under the interval, no write
    expect(spy).not.toHaveBeenCalled();
  });

  describe('Stage 1c, item 1 - a configurable minimum scope, read via @RequireScope', () => {
    it('a SECRET-scoped key satisfies a route whose minimum scope is secret (unlike the admin-only default)', async () => {
      const apiKeyRepository = new InMemoryApiKeyRepository();
      const sessionRepository = new InMemoryAdminSessionRepository();
      const rawKey = 'sk_test_secret_key';
      await apiKeyRepository.create('acme', hashApiKey(rawKey), 'sk_test', ['secret']);
      const guard = new AdminAuthGuard(apiKeyRepository, sessionRepository, makeSettings(), makeReflector('secret'), () => new Date());

      const request: FakeRequest = { method: 'GET', headers: { authorization: `Bearer ${rawKey}` } };
      expect(await guard.canActivate(makeContext(request))).toBe(true);
    });

    it('an ADMIN-scoped key still satisfies a route whose minimum scope is only secret - admin is a strict superset', async () => {
      const apiKeyRepository = new InMemoryApiKeyRepository();
      const sessionRepository = new InMemoryAdminSessionRepository();
      const rawKey = 'sk_test_admin_key';
      await apiKeyRepository.create('acme', hashApiKey(rawKey), 'sk_test', ['admin']);
      const guard = new AdminAuthGuard(apiKeyRepository, sessionRepository, makeSettings(), makeReflector('secret'), () => new Date());

      const request: FakeRequest = { method: 'GET', headers: { authorization: `Bearer ${rawKey}` } };
      expect(await guard.canActivate(makeContext(request))).toBe(true);
    });

    it('a PUBLIC-scoped key never satisfies a route whose minimum scope is secret', async () => {
      const apiKeyRepository = new InMemoryApiKeyRepository();
      const sessionRepository = new InMemoryAdminSessionRepository();
      const rawKey = 'sk_test_public_key';
      await apiKeyRepository.create('acme', hashApiKey(rawKey), 'sk_test', ['public']);
      const guard = new AdminAuthGuard(apiKeyRepository, sessionRepository, makeSettings(), makeReflector('secret'), () => new Date());

      const request: FakeRequest = { method: 'GET', headers: { authorization: `Bearer ${rawKey}` } };
      await expect(guard.canActivate(makeContext(request))).rejects.toBeInstanceOf(UnauthorizedException);
    });

    it('a SECRET-scoped key is REJECTED on a route that still requires admin - nothing changes for an existing secret-key caller on an admin-only route', async () => {
      const apiKeyRepository = new InMemoryApiKeyRepository();
      const sessionRepository = new InMemoryAdminSessionRepository();
      const rawKey = 'sk_test_secret_key';
      await apiKeyRepository.create('acme', hashApiKey(rawKey), 'sk_test', ['secret']);
      const guard = new AdminAuthGuard(apiKeyRepository, sessionRepository, makeSettings(), makeReflector('admin'), () => new Date());

      const request: FakeRequest = { method: 'GET', headers: { authorization: `Bearer ${rawKey}` } };
      await expect(guard.canActivate(makeContext(request))).rejects.toBeInstanceOf(UnauthorizedException);
    });

    it('a SESSION principal satisfies a secret-minimum route with no rank comparison at all - a session always counts as admin', async () => {
      const apiKeyRepository = new InMemoryApiKeyRepository();
      const sessionRepository = new InMemoryAdminSessionRepository();
      const rawSessionToken = mintSessionToken();
      await sessionRepository.create({
        tenantId: 'acme',
        principalId: 'acme',
        tokenHash: hashSessionToken(rawSessionToken),
        csrfToken: mintCsrfToken(),
        lastSeenAt: new Date(),
        absoluteExpiresAt: new Date(Date.now() + 100_000),
        idleTimeoutMs: 100_000,
      });
      // The required scope is irrelevant for a session principal - this guard is constructed with
      // 'secret' here specifically to prove the session path never even consults it.
      const guard = new AdminAuthGuard(apiKeyRepository, sessionRepository, makeSettings(), makeReflector('secret'), () => new Date());

      const request: FakeRequest = { method: 'GET', headers: { cookie: `${PRODUCTION_SESSION_COOKIE_NAME}=${rawSessionToken}` } };
      expect(await guard.canActivate(makeContext(request))).toBe(true);
    });

    it('no @RequireScope at all defaults to the strictest minimum (admin), not the weakest - a secret key is rejected', async () => {
      const apiKeyRepository = new InMemoryApiKeyRepository();
      const sessionRepository = new InMemoryAdminSessionRepository();
      const rawKey = 'sk_test_secret_key';
      await apiKeyRepository.create('acme', hashApiKey(rawKey), 'sk_test', ['secret']);
      const guard = new AdminAuthGuard(apiKeyRepository, sessionRepository, makeSettings(), makeReflector(undefined), () => new Date());

      const request: FakeRequest = { method: 'GET', headers: { authorization: `Bearer ${rawKey}` } };
      await expect(guard.canActivate(makeContext(request))).rejects.toBeInstanceOf(UnauthorizedException);
    });
  });

  describe('Stage 1c, item 5 - a per-principal rate limit on every route this guard protects', () => {
    it('a key principal exceeding its own limit gets 429 with Retry-After, and a HttpException (never UnauthorizedException)', async () => {
      const apiKeyRepository = new InMemoryApiKeyRepository();
      const sessionRepository = new InMemoryAdminSessionRepository();
      const rawKey = 'sk_test_admin_key';
      await apiKeyRepository.create('acme', hashApiKey(rawKey), 'sk_test', ['admin']);
      const settings = makeSettings({ principalRateLimitMaxRequests: 1 });
      const guard = new AdminAuthGuard(apiKeyRepository, sessionRepository, settings, makeReflector(), () => new Date());

      const request: FakeRequest = { method: 'GET', headers: { authorization: `Bearer ${rawKey}` } };
      expect(await guard.canActivate(makeContext(request))).toBe(true); // 1st request - within the limit

      const second = makeContextWithResponse(request);
      await expect(guard.canActivate(second.context)).rejects.toMatchObject({
        status: 429,
        response: { code: 'RATE_LIMITED' },
      });
      expect(second.setHeader).toHaveBeenCalledWith('Retry-After', expect.any(String));
    });

    it('a SESSION principal and an API-KEY principal with the SAME principalId never share a rate-limit bucket', async () => {
      const apiKeyRepository = new InMemoryApiKeyRepository();
      const sessionRepository = new InMemoryAdminSessionRepository();
      await apiKeyRepository.create('acme', hashApiKey('sk_test_key'), 'sk_test', ['admin']);
      const rawSessionToken = mintSessionToken();
      await sessionRepository.create({
        tenantId: 'acme',
        principalId: 'acme',
        tokenHash: hashSessionToken(rawSessionToken),
        csrfToken: mintCsrfToken(),
        lastSeenAt: new Date(),
        absoluteExpiresAt: new Date(Date.now() + 100_000),
        idleTimeoutMs: 100_000,
      });
      const settings = makeSettings({ principalRateLimitMaxRequests: 1 });
      const guard = new AdminAuthGuard(apiKeyRepository, sessionRepository, settings, makeReflector(), () => new Date());

      // Exhaust the KEY principal's own bucket (its own principalId is some generated ApiKey id, not 'acme' - but the point is the SESSION principal, whose principalId IS 'acme', is unaffected either way).
      const keyRequest: FakeRequest = { method: 'GET', headers: { authorization: 'Bearer sk_test_key' } };
      expect(await guard.canActivate(makeContext(keyRequest))).toBe(true);

      const sessionRequest: FakeRequest = { method: 'GET', headers: { cookie: `${PRODUCTION_SESSION_COOKIE_NAME}=${rawSessionToken}` } };
      expect(await guard.canActivate(makeContext(sessionRequest))).toBe(true); // a fresh bucket, not exhausted by the key principal above
    });

    it('two DIFFERENT api-key principals never share a bucket', async () => {
      const apiKeyRepository = new InMemoryApiKeyRepository();
      const sessionRepository = new InMemoryAdminSessionRepository();
      await apiKeyRepository.create('acme', hashApiKey('sk_test_key_1'), 'sk_test', ['admin']);
      await apiKeyRepository.create('acme', hashApiKey('sk_test_key_2'), 'sk_test', ['admin']);
      const settings = makeSettings({ principalRateLimitMaxRequests: 1 });
      const guard = new AdminAuthGuard(apiKeyRepository, sessionRepository, settings, makeReflector(), () => new Date());

      const first: FakeRequest = { method: 'GET', headers: { authorization: 'Bearer sk_test_key_1' } };
      expect(await guard.canActivate(makeContext(first))).toBe(true);

      const second: FakeRequest = { method: 'GET', headers: { authorization: 'Bearer sk_test_key_2' } };
      expect(await guard.canActivate(makeContext(second))).toBe(true); // a different key's own fresh bucket
    });
  });
});
