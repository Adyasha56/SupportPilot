import { describe, expect, it } from 'vitest';
import { InMemoryAdminCredentialRepository } from '../db/test-utils/in-memory-admin-credential.repository';
import { VerifyPasswordService } from './verify-password.service';
import { HashConcurrencyLimiter, hashPassword } from './password-hash';
import { AdminAuthSettings } from './admin-auth.settings';
import { AdminPrincipal } from './admin-auth.guard';

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

const SESSION_PRINCIPAL: AdminPrincipal = { tenantId: 'acme', principalId: 'acme', kind: 'session', sessionId: 's1', csrfToken: 'x' };
const API_KEY_PRINCIPAL: AdminPrincipal = { tenantId: 'acme', principalId: 'key_1', kind: 'api_key' };

describe('VerifyPasswordService (item 7 - step-up primitive)', () => {
  it('a SESSION principal with the correct password gets ok, and resets the lockout counters', async () => {
    const credentialRepository = new InMemoryAdminCredentialRepository();
    await credentialRepository.upsert('acme', 'admin@acme.example', await hashPassword('correct-password'));
    const service = new VerifyPasswordService(credentialRepository, makeSettings(), new HashConcurrencyLimiter(4, 20));

    const result = await service.verifyPassword(SESSION_PRINCIPAL, 'correct-password');
    expect(result).toEqual({ kind: 'ok' });
  });

  it('a SESSION principal with the WRONG password gets invalid_password and increments the SAME lockout counters a login would', async () => {
    const credentialRepository = new InMemoryAdminCredentialRepository();
    await credentialRepository.upsert('acme', 'admin@acme.example', await hashPassword('correct-password'));
    const service = new VerifyPasswordService(credentialRepository, makeSettings(), new HashConcurrencyLimiter(4, 20));

    const result = await service.verifyPassword(SESSION_PRINCIPAL, 'wrong-password');
    expect(result).toEqual({ kind: 'invalid_password' });
    const credential = await credentialRepository.findByTenantId('acme');
    expect(credential!.failedAttempts).toBe(1);
  });

  it('an API-KEY principal is rejected structurally, BEFORE any password is even checked - the rule this service itself enforces', async () => {
    const credentialRepository = new InMemoryAdminCredentialRepository();
    await credentialRepository.upsert('acme', 'admin@acme.example', await hashPassword('correct-password'));
    const service = new VerifyPasswordService(credentialRepository, makeSettings(), new HashConcurrencyLimiter(4, 20));

    // Even the CORRECT password is rejected - the principal kind alone decides this.
    const result = await service.verifyPassword(API_KEY_PRINCIPAL, 'correct-password');
    expect(result).toEqual({ kind: 'not_session_principal' });

    const credential = await credentialRepository.findByTenantId('acme');
    expect(credential!.failedAttempts).toBe(0); // never even touched - no attempt was ever made.
  });

  it('a locked credential verifies the step-up password against the dummy hash too, never the real one', async () => {
    const credentialRepository = new InMemoryAdminCredentialRepository();
    await credentialRepository.upsert('acme', 'admin@acme.example', await hashPassword('correct-password'));
    const now = new Date();
    await credentialRepository.incrementFailedAttempts('acme', new Date(now.getTime() + 60_000));
    const service = new VerifyPasswordService(credentialRepository, makeSettings(), new HashConcurrencyLimiter(4, 20), () => now);

    const result = await service.verifyPassword(SESSION_PRINCIPAL, 'correct-password');
    expect(result).toEqual({ kind: 'invalid_password' });
  });

  it('a full hash queue returns queue_full', async () => {
    const credentialRepository = new InMemoryAdminCredentialRepository();
    await credentialRepository.upsert('acme', 'admin@acme.example', await hashPassword('correct-password'));
    const service = new VerifyPasswordService(credentialRepository, makeSettings(), new HashConcurrencyLimiter(0, 0));

    const result = await service.verifyPassword(SESSION_PRINCIPAL, 'correct-password');
    expect(result).toEqual({ kind: 'queue_full' });
  });

  it('no database configured returns not_configured, never a crash', async () => {
    const service = new VerifyPasswordService(undefined, makeSettings(), new HashConcurrencyLimiter(4, 20));
    const result = await service.verifyPassword(SESSION_PRINCIPAL, 'anything');
    expect(result).toEqual({ kind: 'not_configured' });
  });
});
