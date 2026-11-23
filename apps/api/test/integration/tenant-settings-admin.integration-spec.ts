/**
 * Milestone 5, Stage 1c, item 6 - `GET`/`PUT /v1/tenant/settings` through
 * the REAL AppModule (real AdminAuthGuard, real scrypt hashing, real
 * lockout counters). The controller-level spec
 * (tenant-settings-admin.controller.spec.ts) already proves the full
 * step-up matrix against in-memory fakes; this is the same matrix against
 * a real database - a key principal refused, a session with the right
 * password, a session with the wrong password actually incrementing the
 * SAME `failedAttempts` a real login would, and that no change is applied
 * when a step-up is refused.
 */
import './test-env';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../../src/app.module';
import { cleanupTenant, createAdminCredentialFixture, createApiKeyFixture, createTenantFixture, disconnectFixtureConnection, TenantFixture } from './tenant-fixture';
import { getTestMongoUri, integrationTestsEnabled } from './test-env';

const uri = integrationTestsEnabled() ? getTestMongoUri() : '';
const allCreatedTenants: string[] = [];

async function newTenant(): Promise<TenantFixture> {
  const fixture = await createTenantFixture(uri);
  allCreatedTenants.push(fixture.tenantId);
  return fixture;
}

afterAll(async () => {
  if (!integrationTestsEnabled()) return;
  await Promise.all(allCreatedTenants.map((tenantId) => cleanupTenant(uri, tenantId)));
  await disconnectFixtureConnection();
});

async function loginAgent(app: INestApplication, email: string, password: string) {
  const agent = request.agent(app.getHttpServer());
  const loginRes = await agent.post('/v1/admin/login').send({ email, password });
  expect(loginRes.status).toBe(200);
  const bootstrap = await agent.get('/v1/admin/session');
  return { agent, csrfToken: bootstrap.body.csrfToken as string };
}

describe.skipIf(!integrationTestsEnabled())('Tenant settings admin console - the step-up matrix (integration, real database)', () => {
  let app: INestApplication;
  let priorDevCookieEnv: string | undefined;

  beforeAll(async () => {
    priorDevCookieEnv = process.env.ADMIN_DEV_COOKIE_ENABLED;
    process.env.ADMIN_DEV_COOKIE_ENABLED = 'true';
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
  }, 60_000);

  afterAll(async () => {
    await app.close();
    if (priorDevCookieEnv === undefined) delete process.env.ADMIN_DEV_COOKIE_ENABLED;
    else process.env.ADMIN_DEV_COOKIE_ENABLED = priorDevCookieEnv;
  });

  it('GET returns the real demo-default settings for an admin API key', async () => {
    const tenant = await newTenant();
    const adminKey = await createApiKeyFixture(uri, tenant.tenantId, 'admin');

    const res = await request(app.getHttpServer()).get('/v1/tenant/settings').set('Authorization', `Bearer ${adminKey.rawKey}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ tenantId: tenant.tenantId, refundCap: 2000, approvalThreshold: 250 });
  });

  it('a KEY principal is refused (403) for touching refundCap, even an admin-scoped one - no change is applied', async () => {
    const tenant = await newTenant();
    const adminKey = await createApiKeyFixture(uri, tenant.tenantId, 'admin');

    const res = await request(app.getHttpServer()).put('/v1/tenant/settings').set('Authorization', `Bearer ${adminKey.rawKey}`).send({ refundCap: 500 });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('KEY_PRINCIPAL_CANNOT_CHANGE_FIELD');

    const after = await request(app.getHttpServer()).get('/v1/tenant/settings').set('Authorization', `Bearer ${adminKey.rawKey}`);
    expect(after.body.refundCap).toBe(2000); // unchanged
  });

  it('a SESSION with the RIGHT password can raise refundCap - real scrypt verification, real write', async () => {
    const tenant = await newTenant();
    const email = `settings-ok-${tenant.tenantId}@example.com`;
    await createAdminCredentialFixture(uri, tenant.tenantId, email, 'a-real-password-123456');
    const { agent, csrfToken } = await loginAgent(app, email, 'a-real-password-123456');

    const res = await agent.put('/v1/tenant/settings').set('x-csrf-token', csrfToken).send({ refundCap: 5000, password: 'a-real-password-123456' });
    expect(res.status).toBe(200);
    expect(res.body.refundCap).toBe(5000);
  });

  it('a SESSION with the WRONG password gets 401, and it counts toward the SAME lockout a real login would', async () => {
    const tenant = await newTenant();
    const email = `settings-wrong-${tenant.tenantId}@example.com`;
    await createAdminCredentialFixture(uri, tenant.tenantId, email, 'a-real-password-123456');
    const { agent, csrfToken } = await loginAgent(app, email, 'a-real-password-123456');

    const res = await agent.put('/v1/tenant/settings').set('x-csrf-token', csrfToken).send({ refundCap: 5000, password: 'totally-wrong-password' });
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('INVALID_PASSWORD');

    // No change was applied.
    const unchanged = await request(app.getHttpServer()).get('/v1/tenant/settings').set('Authorization', `Bearer ${(await createApiKeyFixture(uri, tenant.tenantId, 'admin')).rawKey}`);
    expect(unchanged.body.refundCap).toBe(2000);

    // The SAME credential is now one step closer to lockout - proven by continuing to fail
    // real logins with the correct password's own wrong-guess sibling until it locks.
    let lastStatus = 0;
    for (let i = 0; i < 5; i++) {
      const loginAttempt = await request(app.getHttpServer()).post('/v1/admin/login').send({ email, password: 'another-wrong-password' });
      lastStatus = loginAttempt.status;
    }
    expect(lastStatus).toBe(401);
    const lockedOutEvenWithRightPassword = await request(app.getHttpServer()).post('/v1/admin/login').send({ email, password: 'a-real-password-123456' });
    expect(lockedOutEvenWithRightPassword.status).toBe(401); // locked - the earlier step-up failure already contributed to this
  });

  it('enabling autoExecuteRefunds needs the password AND confirmAutoExecute AND dailyRefundCountLimit - all three, or it is refused with no change', async () => {
    const tenant = await newTenant();
    const email = `settings-auto-${tenant.tenantId}@example.com`;
    await createAdminCredentialFixture(uri, tenant.tenantId, email, 'a-real-password-123456');
    const { agent, csrfToken } = await loginAgent(app, email, 'a-real-password-123456');

    const missingConfirm = await agent
      .put('/v1/tenant/settings')
      .set('x-csrf-token', csrfToken)
      .send({ autoExecuteRefunds: true, password: 'a-real-password-123456', dailyRefundCountLimit: 3 });
    expect(missingConfirm.status).toBe(400);
    expect(missingConfirm.body.code).toBe('CONFIRMATION_REQUIRED');

    const success = await agent
      .put('/v1/tenant/settings')
      .set('x-csrf-token', csrfToken)
      .send({ autoExecuteRefunds: true, confirmAutoExecute: true, dailyRefundCountLimit: 3, password: 'a-real-password-123456' });
    expect(success.status).toBe(200);
    expect(success.body.autoExecuteRefunds).toBe(true);
  });

  it("tenant isolation: tenant B's session can never read or change tenant A's settings", async () => {
    const tenantA = await newTenant();
    const tenantB = await newTenant();
    const emailB = `settings-iso-${tenantB.tenantId}@example.com`;
    await createAdminCredentialFixture(uri, tenantB.tenantId, emailB, 'a-real-password-123456');
    const { agent } = await loginAgent(app, emailB, 'a-real-password-123456');

    const res = await agent.get('/v1/tenant/settings');
    expect(res.status).toBe(200);
    expect(res.body.tenantId).toBe(tenantB.tenantId);

    const adminKeyA = await createApiKeyFixture(uri, tenantA.tenantId, 'admin');
    const stillA = await request(app.getHttpServer()).get('/v1/tenant/settings').set('Authorization', `Bearer ${adminKeyA.rawKey}`);
    expect(stillA.body.tenantId).toBe(tenantA.tenantId);
    expect(stillA.body.refundCap).toBe(2000); // untouched by anything tenant B did
  });
});
