import { afterEach, describe, expect, it, vi } from 'vitest';
import { INestApplication, Logger } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AdminAuthGuard } from '../admin-auth/admin-auth.guard';
import { AdminAuthSettings } from '../admin-auth/admin-auth.settings';
import { ADMIN_AUTH_SETTINGS } from '../admin-auth/admin-auth-settings.provider';
import { PRODUCTION_SESSION_COOKIE_NAME } from '../admin-auth/cookie-utils';
import { ADMIN_HASH_CONCURRENCY_LIMITER } from '../admin-auth/hash-concurrency-limiter.provider';
import { HashConcurrencyLimiter, hashPassword } from '../admin-auth/password-hash';
import { hashSessionToken, mintCsrfToken, mintSessionToken } from '../admin-auth/session-token';
import { VerifyPasswordService } from '../admin-auth/verify-password.service';
import { generateRawApiKey, getKeyPrefix, hashApiKey } from '../auth/api-key.service';
import { ADMIN_CREDENTIAL_REPOSITORY } from '../db/admin-credential.repository';
import { API_KEY_REPOSITORY } from '../db/api-key.repository';
import { ADMIN_SESSION_REPOSITORY } from '../db/admin-session.repository';
import { TENANT_REPOSITORY } from '../db/tenant.repository';
import { InMemoryAdminCredentialRepository } from '../db/test-utils/in-memory-admin-credential.repository';
import { InMemoryApiKeyRepository } from '../db/test-utils/in-memory-api-key.repository';
import { InMemoryAdminSessionRepository } from '../db/test-utils/in-memory-admin-session.repository';
import { InMemoryTenantRepository } from '../db/test-utils/in-memory-tenant.repository';
import { TenantSettingsAdminController } from './tenant-settings-admin.controller';
import { TenantSettingsAdminService } from './tenant-settings-admin.service';

const ALLOWED_ORIGIN = 'https://admin.supportpilot.example';

function adminAuthSettings(overrides: Partial<AdminAuthSettings> = {}): AdminAuthSettings {
  return {
    hashMaxConcurrency: 6,
    hashMaxQueueLength: 20,
    sessionAbsoluteLifetimeMs: 8 * 60 * 60 * 1000,
    sessionIdleTimeoutMs: 30 * 60 * 1000,
    sessionLastSeenWriteIntervalMs: 60_000,
    lockoutFreeAttempts: 3,
    lockoutBaseMs: 1_000,
    lockoutCapMs: 15 * 60 * 1000,
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

const DEMO_SETTINGS = { refundCap: 2000, approvalThreshold: 250, refundWindowDays: 30, autoExecuteRefunds: false, approvalExpiryDays: 7 };

async function buildApp() {
  const apiKeyRepository = new InMemoryApiKeyRepository();
  const sessionRepository = new InMemoryAdminSessionRepository();
  const tenantRepository = new InMemoryTenantRepository();
  const credentialRepository = new InMemoryAdminCredentialRepository();

  const moduleRef = await Test.createTestingModule({
    controllers: [TenantSettingsAdminController],
    providers: [
      TenantSettingsAdminService,
      VerifyPasswordService,
      AdminAuthGuard,
      Reflector,
      { provide: API_KEY_REPOSITORY, useValue: apiKeyRepository },
      { provide: ADMIN_SESSION_REPOSITORY, useValue: sessionRepository },
      { provide: ADMIN_AUTH_SETTINGS, useValue: adminAuthSettings() },
      { provide: TENANT_REPOSITORY, useValue: tenantRepository },
      { provide: ADMIN_CREDENTIAL_REPOSITORY, useValue: credentialRepository },
      { provide: ADMIN_HASH_CONCURRENCY_LIMITER, useValue: new HashConcurrencyLimiter(6, 20) },
    ],
  }).compile();

  const app = moduleRef.createNestApplication();
  await app.init();

  await tenantRepository.upsert('acme', 'Acme');
  tenantRepository.setSettings('acme', DEMO_SETTINGS);
  await credentialRepository.upsert('acme', 'admin@acme.example', await hashPassword('correct-password'));

  async function createKey(tenantId: string, scope: 'public' | 'secret' | 'admin' = 'admin') {
    const rawKey = generateRawApiKey();
    await apiKeyRepository.create(tenantId, hashApiKey(rawKey), getKeyPrefix(rawKey), [scope]);
    return rawKey;
  }

  async function createSession(tenantId: string) {
    const rawSessionToken = mintSessionToken();
    const csrfToken = mintCsrfToken();
    await sessionRepository.create({
      tenantId,
      principalId: tenantId,
      tokenHash: hashSessionToken(rawSessionToken),
      csrfToken,
      lastSeenAt: new Date(),
      absoluteExpiresAt: new Date(Date.now() + 100_000),
      idleTimeoutMs: 100_000,
    });
    return { cookie: `${PRODUCTION_SESSION_COOKIE_NAME}=${rawSessionToken}`, csrfToken };
  }

  return { app, tenantRepository, credentialRepository, createKey, createSession };
}

describe('TenantSettingsAdminController (Stage 1c, item 3)', () => {
  let app: INestApplication | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  describe('GET /v1/tenant/settings', () => {
    it('returns the settings for an ADMIN-scoped key', async () => {
      const built = await buildApp();
      app = built.app;
      const rawKey = await built.createKey('acme');

      const res = await request(app.getHttpServer()).get('/v1/tenant/settings').set('Authorization', `Bearer ${rawKey}`);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ tenantId: 'acme', ...DEMO_SETTINGS });
    });

    it('a SECRET-scoped key is rejected - admin is required, like approvals and conversations', async () => {
      const built = await buildApp();
      app = built.app;
      const rawKey = await built.createKey('acme', 'secret');

      const res = await request(app.getHttpServer()).get('/v1/tenant/settings').set('Authorization', `Bearer ${rawKey}`);
      expect(res.status).toBe(401);
    });
  });

  describe('PUT /v1/tenant/settings - non-restricted fields (approvalThreshold, refundWindowDays, approvalExpiryDays, dailyRefundCountLimit)', () => {
    it('an admin API key can change a non-restricted field with no password at all', async () => {
      const built = await buildApp();
      app = built.app;
      const rawKey = await built.createKey('acme');

      const res = await request(app.getHttpServer()).put('/v1/tenant/settings').set('Authorization', `Bearer ${rawKey}`).send({ approvalThreshold: 300 });
      expect(res.status).toBe(200);
      expect(res.body.approvalThreshold).toBe(300);
    });

    it('rejects an empty body with no settings at all', async () => {
      const built = await buildApp();
      app = built.app;
      const rawKey = await built.createKey('acme');

      const res = await request(app.getHttpServer()).put('/v1/tenant/settings').set('Authorization', `Bearer ${rawKey}`).send({});
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('INVALID_REQUEST');
    });

    it('rejects a value that fails cross-field validation (approvalThreshold above refundCap) with 422', async () => {
      const built = await buildApp();
      app = built.app;
      const rawKey = await built.createKey('acme');

      const res = await request(app.getHttpServer()).put('/v1/tenant/settings').set('Authorization', `Bearer ${rawKey}`).send({ approvalThreshold: 99999 });
      expect(res.status).toBe(422);
      expect(res.body.code).toBe('VALIDATION_FAILED');
    });
  });

  describe('PUT /v1/tenant/settings - the restricted fields (refundCap, autoExecuteRefunds)', () => {
    it('an admin API key can NEVER change refundCap, even to LOWER it - generic 403', async () => {
      const built = await buildApp();
      app = built.app;
      const rawKey = await built.createKey('acme');

      const res = await request(app.getHttpServer()).put('/v1/tenant/settings').set('Authorization', `Bearer ${rawKey}`).send({ refundCap: 1000 });
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('KEY_PRINCIPAL_CANNOT_CHANGE_FIELD');

      const tenant = await built.tenantRepository.findById('acme');
      expect(tenant!.refundCap).toBe(2000); // unchanged
    });

    it('an admin API key can NEVER enable autoExecuteRefunds either', async () => {
      const built = await buildApp();
      app = built.app;
      const rawKey = await built.createKey('acme');

      const res = await request(app.getHttpServer())
        .put('/v1/tenant/settings')
        .set('Authorization', `Bearer ${rawKey}`)
        .send({ autoExecuteRefunds: true, confirmAutoExecute: true, dailyRefundCountLimit: 3 });
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('KEY_PRINCIPAL_CANNOT_CHANGE_FIELD');
    });

    it('a session LOWERING refundCap needs no password at all', async () => {
      const built = await buildApp();
      app = built.app;
      const { cookie, csrfToken } = await built.createSession('acme');

      const res = await request(app.getHttpServer())
        .put('/v1/tenant/settings')
        .set('Cookie', cookie)
        .set('x-csrf-token', csrfToken)
        .set('Origin', ALLOWED_ORIGIN)
        .send({ refundCap: 1000 });
      expect(res.status).toBe(200);
      expect(res.body.refundCap).toBe(1000);
    });

    it('a session RAISING refundCap with NO password gets step_up_required', async () => {
      const built = await buildApp();
      app = built.app;
      const { cookie, csrfToken } = await built.createSession('acme');

      const res = await request(app.getHttpServer())
        .put('/v1/tenant/settings')
        .set('Cookie', cookie)
        .set('x-csrf-token', csrfToken)
        .set('Origin', ALLOWED_ORIGIN)
        .send({ refundCap: 3000 });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('STEP_UP_REQUIRED');

      const tenant = await built.tenantRepository.findById('acme');
      expect(tenant!.refundCap).toBe(2000); // unchanged - never applied without the step-up
    });

    it('a session RAISING refundCap with the WRONG password gets invalid_password, and it counts toward the credential lockout', async () => {
      const built = await buildApp();
      app = built.app;
      const { cookie, csrfToken } = await built.createSession('acme');

      const res = await request(app.getHttpServer())
        .put('/v1/tenant/settings')
        .set('Cookie', cookie)
        .set('x-csrf-token', csrfToken)
        .set('Origin', ALLOWED_ORIGIN)
        .send({ refundCap: 3000, password: 'wrong-password' });
      expect(res.status).toBe(401);
      expect(res.body.code).toBe('INVALID_PASSWORD');

      const credential = await built.credentialRepository.findByTenantId('acme');
      expect(credential!.failedAttempts).toBe(1);
    });

    it('a session RAISING refundCap with the RIGHT password succeeds', async () => {
      const built = await buildApp();
      app = built.app;
      const { cookie, csrfToken } = await built.createSession('acme');

      const res = await request(app.getHttpServer())
        .put('/v1/tenant/settings')
        .set('Cookie', cookie)
        .set('x-csrf-token', csrfToken)
        .set('Origin', ALLOWED_ORIGIN)
        .send({ refundCap: 3000, password: 'correct-password' });
      expect(res.status).toBe(200);
      expect(res.body.refundCap).toBe(3000);
    });

    it('a session enabling autoExecuteRefunds with the right password but WITHOUT confirmAutoExecute gets confirmation_required', async () => {
      const built = await buildApp();
      app = built.app;
      const { cookie, csrfToken } = await built.createSession('acme');

      const res = await request(app.getHttpServer())
        .put('/v1/tenant/settings')
        .set('Cookie', cookie)
        .set('x-csrf-token', csrfToken)
        .set('Origin', ALLOWED_ORIGIN)
        .send({ autoExecuteRefunds: true, password: 'correct-password', dailyRefundCountLimit: 3 });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('CONFIRMATION_REQUIRED');
    });

    it('a session enabling autoExecuteRefunds with the right password AND confirmAutoExecute AND dailyRefundCountLimit succeeds', async () => {
      const built = await buildApp();
      app = built.app;
      const { cookie, csrfToken } = await built.createSession('acme');

      const res = await request(app.getHttpServer())
        .put('/v1/tenant/settings')
        .set('Cookie', cookie)
        .set('x-csrf-token', csrfToken)
        .set('Origin', ALLOWED_ORIGIN)
        .send({ autoExecuteRefunds: true, confirmAutoExecute: true, dailyRefundCountLimit: 3, password: 'correct-password' });
      expect(res.status).toBe(200);
      expect(res.body.autoExecuteRefunds).toBe(true);
    });

    it('a session DISABLING autoExecuteRefunds needs no password and no confirmation', async () => {
      const built = await buildApp();
      app = built.app;
      built.tenantRepository.setSettings('acme', { ...DEMO_SETTINGS, autoExecuteRefunds: true, dailyRefundCountLimit: 3 });
      const { cookie, csrfToken } = await built.createSession('acme');

      const res = await request(app.getHttpServer())
        .put('/v1/tenant/settings')
        .set('Cookie', cookie)
        .set('x-csrf-token', csrfToken)
        .set('Origin', ALLOWED_ORIGIN)
        .send({ autoExecuteRefunds: false });
      expect(res.status).toBe(200);
      expect(res.body.autoExecuteRefunds).toBe(false);
    });

    it('a secret-scoped key is rejected before any restricted-field logic is even reached', async () => {
      const built = await buildApp();
      app = built.app;
      const rawKey = await built.createKey('acme', 'secret');

      const res = await request(app.getHttpServer()).put('/v1/tenant/settings').set('Authorization', `Bearer ${rawKey}`).send({ refundCap: 1000 });
      expect(res.status).toBe(401);
    });
  });

  describe('audit logging', () => {
    it('logs the principal id, changed field names, and old/new values - and never a password', async () => {
      const logSpy = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
      const built = await buildApp();
      app = built.app;
      const { cookie, csrfToken } = await built.createSession('acme');

      await request(app.getHttpServer())
        .put('/v1/tenant/settings')
        .set('Cookie', cookie)
        .set('x-csrf-token', csrfToken)
        .set('Origin', ALLOWED_ORIGIN)
        .send({ refundCap: 3000, password: 'correct-password' });

      const loggedText = logSpy.mock.calls.map((call) => String(call[0])).join('\n');
      logSpy.mockRestore();

      expect(loggedText).toContain('tenant_settings_changed_via_admin_api');
      expect(loggedText).toContain('"principalId":"acme"');
      expect(loggedText).toContain('"refundCap"');
      expect(loggedText).not.toContain('correct-password');
    });
  });
});
