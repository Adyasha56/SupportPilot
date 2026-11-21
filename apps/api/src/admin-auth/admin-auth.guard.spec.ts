import { ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { InMemoryApiKeyRepository } from '../db/test-utils/in-memory-api-key.repository';
import { InMemoryAdminSessionRepository } from '../db/test-utils/in-memory-admin-session.repository';
import { hashApiKey } from '../auth/api-key.service';
import { AdminAuthGuard } from './admin-auth.guard';
import { AdminAuthSettings } from './admin-auth.settings';
import { hashSessionToken, mintCsrfToken, mintSessionToken } from './session-token';
import { PRODUCTION_SESSION_COOKIE_NAME } from './cookie-utils';

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
    ...overrides,
  };
}

interface FakeRequest {
  method: string;
  headers: Record<string, string | undefined>;
}

function makeContext(request: FakeRequest): ExecutionContext {
  return { switchToHttp: () => ({ getRequest: () => request }) } as unknown as ExecutionContext;
}

describe('AdminAuthGuard (item 6)', () => {
  it('a valid admin-scoped API key authenticates via the header path, as kind: api_key', async () => {
    const apiKeyRepository = new InMemoryApiKeyRepository();
    const sessionRepository = new InMemoryAdminSessionRepository();
    const rawKey = 'sk_test_admin_key';
    const id = await apiKeyRepository.create('acme', hashApiKey(rawKey), 'sk_test', ['admin']);
    const guard = new AdminAuthGuard(apiKeyRepository, sessionRepository, makeSettings(), () => new Date());

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
    const guard = new AdminAuthGuard(apiKeyRepository, sessionRepository, makeSettings(), () => new Date());

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
    const guard = new AdminAuthGuard(apiKeyRepository, sessionRepository, makeSettings(), () => new Date());

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
    const guard = new AdminAuthGuard(apiKeyRepository, sessionRepository, makeSettings(), () => new Date());

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
    const guard = new AdminAuthGuard(apiKeyRepository, sessionRepository, makeSettings(), () => new Date());

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
    const guard = new AdminAuthGuard(apiKeyRepository, sessionRepository, makeSettings(), () => new Date());

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
    const guard = new AdminAuthGuard(apiKeyRepository, sessionRepository, makeSettings(), () => new Date());

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
    const guard = new AdminAuthGuard(apiKeyRepository, sessionRepository, makeSettings(), () => new Date());

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
    const guard = new AdminAuthGuard(apiKeyRepository, sessionRepository, makeSettings(), () => now);

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
    const guard = new AdminAuthGuard(apiKeyRepository, sessionRepository, makeSettings(), () => now);

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
    const guard = new AdminAuthGuard(apiKeyRepository, sessionRepository, settings, () => now);

    const request: FakeRequest = { method: 'GET', headers: { cookie: `${PRODUCTION_SESSION_COOKIE_NAME}=${rawSessionToken}` } };
    await guard.canActivate(makeContext(request)); // same `now` as lastSeenAt - under the interval, no write
    expect(spy).not.toHaveBeenCalled();
  });
});
