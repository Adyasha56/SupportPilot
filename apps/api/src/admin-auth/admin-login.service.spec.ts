import { describe, expect, it, vi } from 'vitest';
import { InMemoryAdminCredentialRepository } from '../db/test-utils/in-memory-admin-credential.repository';
import { InMemoryAdminSessionRepository } from '../db/test-utils/in-memory-admin-session.repository';
import { RateLimiter } from '../auth/rate-limiter';
import { AdminLoginService } from './admin-login.service';
import { HashConcurrencyLimiter, hashPassword, parseHash } from './password-hash';
import { AdminAuthSettings } from './admin-auth.settings';
import * as passwordHashModule from './password-hash';
import { hashSessionToken } from './session-token';

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
    allowedOrigins: [],
    principalRateLimitMaxRequests: 1000,
    principalRateLimitWindowMs: 60_000,
    principalRateLimitMaxEntries: 1000,
    ...overrides,
  };
}

async function makeHarness(settingsOverrides: Partial<AdminAuthSettings> = {}, now = new Date('2026-01-01T00:00:00.000Z')) {
  const credentialRepository = new InMemoryAdminCredentialRepository();
  const sessionRepository = new InMemoryAdminSessionRepository();
  const settings = makeSettings(settingsOverrides);
  const ipRateLimiter = new RateLimiter({ maxRequests: settings.loginIpRateLimitMaxRequests, windowMs: settings.loginIpRateLimitWindowMs, maxEntries: 1000 }, () => now);
  const hashLimiter = new HashConcurrencyLimiter(settings.hashMaxConcurrency, settings.hashMaxQueueLength);
  const service = new AdminLoginService(credentialRepository, sessionRepository, settings, ipRateLimiter, hashLimiter, () => now);

  const passwordHash = await hashPassword('correct-password-123');
  await credentialRepository.upsert('acme', 'admin@acme.example', passwordHash);

  return { service, credentialRepository, sessionRepository, now };
}

describe('AdminLoginService (items 2/3)', () => {
  it('a successful login creates a session, resets counters, and returns the raw token/csrf/expiry', async () => {
    const { service, sessionRepository } = await makeHarness();
    const result = await service.login({ email: 'admin@acme.example', password: 'correct-password-123', clientIp: '1.2.3.4' });

    expect(result.kind).toBe('success');
    if (result.kind !== 'success') return;
    expect(result.tenantId).toBe('acme');
    expect(result.rawSessionToken).toBeTypeOf('string');
    expect(result.csrfToken).toBeTypeOf('string');
    const sessions = await sessionRepository.findByTokenHash(hashSessionToken(result.rawSessionToken));
    expect(sessions).not.toBeNull();
    expect(sessions!.tenantId).toBe('acme');
  });

  it('Part 0, item Q1 - a successful login against a WEAK stored hash transparently rehashes it to the current parameters', async () => {
    const credentialRepository = new InMemoryAdminCredentialRepository();
    const sessionRepository = new InMemoryAdminSessionRepository();
    const settings = makeSettings();
    const ipRateLimiter = new RateLimiter({ maxRequests: 1000, windowMs: 60_000, maxEntries: 1000 }, () => new Date());
    const hashLimiter = new HashConcurrencyLimiter(4, 20);
    const service = new AdminLoginService(credentialRepository, sessionRepository, settings, ipRateLimiter, hashLimiter);

    const weakHash = await hashPassword('correct-password-123', { n: 16_384, r: 8, p: 1, keylen: 32 });
    await credentialRepository.upsert('acme', 'admin@acme.example', weakHash);

    const result = await service.login({ email: 'admin@acme.example', password: 'correct-password-123', clientIp: '1.2.3.4' });
    expect(result.kind).toBe('success');

    const after = await credentialRepository.findByTenantId('acme');
    expect(after!.passwordHash).not.toBe(weakHash);
    expect(parseHash(after!.passwordHash).p).toBe(5);
    // The upgraded hash still verifies with the same real password - rehashing never changes
    // what password actually unlocks the account.
    const secondLogin = await service.login({ email: 'admin@acme.example', password: 'correct-password-123', clientIp: '1.2.3.4' });
    expect(secondLogin.kind).toBe('success');
  });

  it('an unknown email is invalid_credentials, verified against the DUMMY hash (spy proof), never the real path', async () => {
    const { service } = await makeHarness();
    const spy = vi.spyOn(passwordHashModule, 'verifyDummyHash');

    const result = await service.login({ email: 'nobody@acme.example', password: 'anything', clientIp: '1.2.3.4' });

    expect(result).toEqual({ kind: 'invalid_credentials' });
    expect(spy).toHaveBeenCalledWith('anything');
    spy.mockRestore();
  });

  it('a wrong password is invalid_credentials and increments failedAttempts with a lockout schedule', async () => {
    const { service, credentialRepository } = await makeHarness();
    const result = await service.login({ email: 'admin@acme.example', password: 'wrong-password', clientIp: '1.2.3.4' });

    expect(result).toEqual({ kind: 'invalid_credentials' });
    const credential = await credentialRepository.findByTenantId('acme');
    expect(credential!.failedAttempts).toBe(1);
  });

  it('a LOCKED account verifies against the dummy hash even with the CORRECT password - never the real hash while locked', async () => {
    const now = new Date('2026-01-01T00:00:00.000Z');
    const { service, credentialRepository } = await makeHarness({}, now);
    await credentialRepository.incrementFailedAttempts('acme', new Date(now.getTime() + 60_000)); // locked for the next 60s
    const spy = vi.spyOn(passwordHashModule, 'verifyDummyHash');

    const result = await service.login({ email: 'admin@acme.example', password: 'correct-password-123', clientIp: '1.2.3.4' });

    expect(result).toEqual({ kind: 'invalid_credentials' });
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  it('the three failure cases (unknown email, wrong password, locked account) return the BYTE-IDENTICAL result object', async () => {
    const now = new Date('2026-01-01T00:00:00.000Z');
    const { service, credentialRepository } = await makeHarness({}, now);

    const unknownEmail = await service.login({ email: 'nobody@acme.example', password: 'x', clientIp: '1.2.3.4' });
    const wrongPassword = await service.login({ email: 'admin@acme.example', password: 'wrong', clientIp: '1.2.3.4' });
    await credentialRepository.incrementFailedAttempts('acme', new Date(now.getTime() + 60_000));
    const locked = await service.login({ email: 'admin@acme.example', password: 'correct-password-123', clientIp: '1.2.3.4' });

    expect(unknownEmail).toEqual({ kind: 'invalid_credentials' });
    expect(wrongPassword).toEqual(unknownEmail);
    expect(locked).toEqual(unknownEmail);
  });

  it('a session cookie presented at login is invalidated (anti-fixation) even on a successful login', async () => {
    const { service, sessionRepository } = await makeHarness();
    // Simulate a pre-existing (attacker-fixed) session.
    const priorToken = 'attacker-fixed-raw-token';
    await sessionRepository.create({
      tenantId: 'acme',
      principalId: 'acme',
      tokenHash: hashSessionToken(priorToken),
      csrfToken: 'whatever',
      lastSeenAt: new Date(),
      absoluteExpiresAt: new Date(Date.now() + 100_000),
      idleTimeoutMs: 100_000,
    });

    const result = await service.login({
      email: 'admin@acme.example',
      password: 'correct-password-123',
      clientIp: '1.2.3.4',
      presentedRawSessionToken: priorToken,
    });

    expect(result.kind).toBe('success');
    const priorStillExists = await sessionRepository.findByTokenHash(hashSessionToken(priorToken));
    expect(priorStillExists).toBeNull();
  });

  it('the per-IP rate limiter rejects before any hashing happens', async () => {
    const { service } = await makeHarness({ loginIpRateLimitMaxRequests: 1 });
    const first = await service.login({ email: 'admin@acme.example', password: 'correct-password-123', clientIp: '9.9.9.9' });
    expect(first.kind).toBe('success');

    const second = await service.login({ email: 'admin@acme.example', password: 'anything', clientIp: '9.9.9.9' });
    expect(second).toMatchObject({ kind: 'rate_limited' });
  });

  it('the hash concurrency queue being full returns hash_queue_full, not invalid_credentials', async () => {
    const credentialRepository = new InMemoryAdminCredentialRepository();
    const sessionRepository = new InMemoryAdminSessionRepository();
    const settings = makeSettings({ hashMaxConcurrency: 0, hashMaxQueueLength: 0 });
    const ipRateLimiter = new RateLimiter({ maxRequests: 1000, windowMs: 60_000, maxEntries: 1000 }, () => new Date());
    const hashLimiter = new HashConcurrencyLimiter(0, 0);
    const service = new AdminLoginService(credentialRepository, sessionRepository, settings, ipRateLimiter, hashLimiter, () => new Date());
    await credentialRepository.upsert('acme', 'admin@acme.example', await hashPassword('x'));

    const result = await service.login({ email: 'admin@acme.example', password: 'x', clientIp: '1.2.3.4' });
    expect(result).toEqual({ kind: 'hash_queue_full' });
  });
});
