import { randomBytes } from 'node:crypto';
import { Logger } from '@nestjs/common';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { InMemoryAdminCredentialRepository } from '../db/test-utils/in-memory-admin-credential.repository';
import { InMemoryAdminSessionRepository } from '../db/test-utils/in-memory-admin-session.repository';
import { RateLimiter } from '../auth/rate-limiter';
import { AdminLoginService } from './admin-login.service';
import { HashConcurrencyLimiter, hashPassword } from './password-hash';
import { AdminAuthSettings } from './admin-auth.settings';
import { hashSessionToken } from './session-token';

function makeSettings(): AdminAuthSettings {
  return {
    hashMaxConcurrency: 4,
    hashMaxQueueLength: 20,
    sessionAbsoluteLifetimeMs: 8 * 60 * 60 * 1000,
    sessionIdleTimeoutMs: 30 * 60 * 1000,
    sessionLastSeenWriteIntervalMs: 60_000,
    lockoutFreeAttempts: 3,
    lockoutBaseMs: 1_000,
    lockoutCapMs: 900_000,
    loginIpRateLimitMaxRequests: 1000,
    loginIpRateLimitWindowMs: 60_000,
    loginIpRateLimitMaxEntries: 1000,
    devCookieEnabled: false,
    allowedOrigins: [],
    principalRateLimitMaxRequests: 1000,
    principalRateLimitWindowMs: 60_000,
    principalRateLimitMaxEntries: 1000,
  };
}

/**
 * Milestone 5, Stage 1b, item 9 - a canary proof, same discipline
 * chat-fixtures.ts's own `canaryString()` already uses for the chat
 * persistence suite: a fresh, random, grep-able marker baked into the
 * password/token this test actually sends, so this test can only pass if
 * that EXACT marker never appears anywhere it shouldn't - a hardcoded
 * literal could never accidentally "already be there" from a leftover
 * previous run or a coincidental match.
 */
function canary(label: string): string {
  return `canary-${label}-${randomBytes(8).toString('hex')}`;
}

describe('Admin auth canary (item 9 - password/token never logged, never in a result body)', () => {
  const logSpy = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  const errorSpy = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  const warnSpy = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

  afterEach(() => {
    logSpy.mockClear();
    errorSpy.mockClear();
    warnSpy.mockClear();
  });

  function allLoggedText(): string {
    return [...logSpy.mock.calls, ...errorSpy.mock.calls, ...warnSpy.mock.calls].map((call) => call.map(String).join(' ')).join('\n');
  }

  it('a WRONG password attempt never appears in any log line', async () => {
    const credentialRepository = new InMemoryAdminCredentialRepository();
    const sessionRepository = new InMemoryAdminSessionRepository();
    await credentialRepository.upsert('acme', 'admin@acme.example', await hashPassword('the-real-password-123456'));
    const service = new AdminLoginService(
      credentialRepository,
      sessionRepository,
      makeSettings(),
      new RateLimiter({ maxRequests: 1000, windowMs: 60_000, maxEntries: 1000 }, () => new Date()),
      new HashConcurrencyLimiter(4, 20),
    );

    const wrongPassword = canary('wrong-password');
    const result = await service.login({ email: 'admin@acme.example', password: wrongPassword, clientIp: '1.2.3.4' });

    expect(result).toEqual({ kind: 'invalid_credentials' });
    expect(JSON.stringify(result)).not.toContain(wrongPassword);
    expect(allLoggedText()).not.toContain(wrongPassword);
  });

  it('the CORRECT password, and the newly-minted raw session token, never appear in any log line on a successful login', async () => {
    const credentialRepository = new InMemoryAdminCredentialRepository();
    const sessionRepository = new InMemoryAdminSessionRepository();
    const realPassword = canary('real-password');
    await credentialRepository.upsert('acme', 'admin@acme.example', await hashPassword(realPassword));
    const service = new AdminLoginService(
      credentialRepository,
      sessionRepository,
      makeSettings(),
      new RateLimiter({ maxRequests: 1000, windowMs: 60_000, maxEntries: 1000 }, () => new Date()),
      new HashConcurrencyLimiter(4, 20),
    );

    const result = await service.login({ email: 'admin@acme.example', password: realPassword, clientIp: '1.2.3.4' });
    expect(result.kind).toBe('success');
    if (result.kind !== 'success') return;

    expect(allLoggedText()).not.toContain(realPassword);
    expect(allLoggedText()).not.toContain(result.rawSessionToken);
    expect(allLoggedText()).not.toContain(result.csrfToken);
    // The audit line DOES exist (login_succeeded) - this proves the canary absence isn't just
    // because nothing was logged at all.
    expect(allLoggedText()).toContain('login_succeeded');
  });

  it('a stored AdminSession row never contains the raw token anywhere - only its SHA-256 hash', async () => {
    const credentialRepository = new InMemoryAdminCredentialRepository();
    const sessionRepository = new InMemoryAdminSessionRepository();
    const realPassword = canary('stored-row-password');
    await credentialRepository.upsert('acme', 'admin@acme.example', await hashPassword(realPassword));
    const service = new AdminLoginService(
      credentialRepository,
      sessionRepository,
      makeSettings(),
      new RateLimiter({ maxRequests: 1000, windowMs: 60_000, maxEntries: 1000 }, () => new Date()),
      new HashConcurrencyLimiter(4, 20),
    );

    const result = await service.login({ email: 'admin@acme.example', password: realPassword, clientIp: '1.2.3.4' });
    expect(result.kind).toBe('success');
    if (result.kind !== 'success') return;

    const stored = await sessionRepository.findByTokenHash(hashSessionToken(result.rawSessionToken));
    expect(stored).not.toBeNull();
    expect(JSON.stringify(stored)).not.toContain(result.rawSessionToken);
  });
});
