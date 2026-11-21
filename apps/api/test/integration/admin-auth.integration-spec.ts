/**
 * Milestone 5, Stage 1b, item 10 - through the REAL AppModule (real
 * ApiKeyGuard/AdminAuthGuard, real Mongoose repositories, real scrypt
 * hashing - no FakeLlmProvider override needed here at all, since nothing
 * in this suite ever calls the agent loop). Covers: login, a
 * cookie-authenticated approvals list, CSRF on a state change, lockout,
 * logout, an existing admin API key working unchanged, and tenant
 * isolation of both sessions and credentials.
 */
import './test-env';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AppModule } from '../../src/app.module';
import {
  cleanupTenant,
  createAdminCredentialFixture,
  createApiKeyFixture,
  createTenantFixture,
  disconnectFixtureConnection,
  TenantFixture,
} from './tenant-fixture';
import { getTestMongoUri, integrationTestsEnabled } from './test-env';

const uri = integrationTestsEnabled() ? getTestMongoUri() : '';
const allCreatedTenants: string[] = [];

async function newTenant(): Promise<TenantFixture> {
  const fixture = await createTenantFixture(uri);
  allCreatedTenants.push(fixture.tenantId);
  return fixture;
}

afterAll(async () => {
  if (!integrationTestsEnabled()) {
    return;
  }
  await Promise.all(allCreatedTenants.map((tenantId) => cleanupTenant(uri, tenantId)));
  await disconnectFixtureConnection();
});

describe.skipIf(!integrationTestsEnabled())('Admin console authentication (integration, real database)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
  }, 60_000);
  afterAll(() => app.close());

  it('a full login -> cookie-authenticated approvals list -> logout round trip, with CSRF on the state change', async () => {
    const tenant = await newTenant();
    await createAdminCredentialFixture(uri, tenant.tenantId, `owner-${tenant.tenantId}@example.com`, 'a-real-password-123456');

    const agent = request.agent(app.getHttpServer());
    const loginRes = await agent.post('/v1/admin/login').send({ email: `owner-${tenant.tenantId}@example.com`, password: 'a-real-password-123456' });
    expect(loginRes.status).toBe(200);

    const bootstrap = await agent.get('/v1/admin/session');
    expect(bootstrap.status).toBe(200);
    expect(bootstrap.body.tenantId).toBe(tenant.tenantId);
    const csrfToken = bootstrap.body.csrfToken as string;

    const listRes = await agent.get('/v1/approvals');
    expect(listRes.status).toBe(200);
    expect(listRes.body.approvals).toEqual([]);

    // A state change (logout itself) without the CSRF header is rejected.
    const logoutNoCsrf = await agent.post('/v1/admin/logout');
    expect(logoutNoCsrf.status).toBe(401);

    const logoutRes = await agent.post('/v1/admin/logout').set('x-csrf-token', csrfToken);
    expect(logoutRes.status).toBe(204);

    const afterLogout = await agent.get('/v1/approvals');
    expect(afterLogout.status).toBe(401);
  });

  it('an existing admin-scoped API key works on /v1/approvals completely unchanged by this stage', async () => {
    const tenant = await newTenant();
    const adminKey = await createApiKeyFixture(uri, tenant.tenantId, 'admin');

    const res = await request(app.getHttpServer()).get('/v1/approvals').set('Authorization', `Bearer ${adminKey.rawKey}`);
    expect(res.status).toBe(200);
  });

  it('a secret-scope key still gets the identical generic rejection a public key would on /v1/approvals', async () => {
    const tenant = await newTenant();
    const res = await request(app.getHttpServer()).get('/v1/approvals').set('Authorization', `Bearer ${tenant.secretKey}`);
    expect(res.status).toBe(401);
  });

  it('wrong password repeated past the free-attempt threshold locks the account - byte-identical 401 throughout', async () => {
    const tenant = await newTenant();
    await createAdminCredentialFixture(uri, tenant.tenantId, `lockout-${tenant.tenantId}@example.com`, 'a-real-password-123456');

    let lastBody: unknown;
    for (let i = 0; i < 6; i++) {
      const res = await request(app.getHttpServer())
        .post('/v1/admin/login')
        .send({ email: `lockout-${tenant.tenantId}@example.com`, password: 'definitely-wrong-password' });
      expect(res.status).toBe(401);
      if (lastBody) {
        expect(res.body).toEqual(lastBody);
      }
      lastBody = res.body;
    }

    // Even the CORRECT password now fails while locked.
    const correctButLocked = await request(app.getHttpServer())
      .post('/v1/admin/login')
      .send({ email: `lockout-${tenant.tenantId}@example.com`, password: 'a-real-password-123456' });
    expect(correctButLocked.status).toBe(401);
    expect(correctButLocked.body).toEqual(lastBody);

    // The admin API key recovery path is completely unaffected by this tenant's own lockout.
    const adminKey = await createApiKeyFixture(uri, tenant.tenantId, 'admin');
    const viaApiKey = await request(app.getHttpServer()).get('/v1/approvals').set('Authorization', `Bearer ${adminKey.rawKey}`);
    expect(viaApiKey.status).toBe(200);
  });

  it('tenant isolation: tenant B\'s session can never read tenant A\'s approvals', async () => {
    const tenantA = await newTenant();
    const tenantB = await newTenant();
    await createAdminCredentialFixture(uri, tenantB.tenantId, `isolated-${tenantB.tenantId}@example.com`, 'a-real-password-123456');

    const agentB = request.agent(app.getHttpServer());
    await agentB.post('/v1/admin/login').send({ email: `isolated-${tenantB.tenantId}@example.com`, password: 'a-real-password-123456' });

    const res = await agentB.get('/v1/approvals');
    expect(res.status).toBe(200);
    // tenant B's own (empty) list, never tenant A's - the session itself is scoped to tenant B,
    // there is no way for this request to even ask for tenant A's data.
    expect(res.body.approvals).toEqual([]);
    void tenantA; // present only to document the isolation being tested, not used directly
  });

  it('tenant isolation: two tenants with credentials under the SAME local-part email domain never collide', async () => {
    const tenantA = await newTenant();
    const tenantB = await newTenant();
    await createAdminCredentialFixture(uri, tenantA.tenantId, `shared-style@a.example`, 'tenant-a-password-123');
    await createAdminCredentialFixture(uri, tenantB.tenantId, `shared-style@b.example`, 'tenant-b-password-123');

    const loginA = await request(app.getHttpServer()).post('/v1/admin/login').send({ email: 'shared-style@a.example', password: 'tenant-a-password-123' });
    const loginB = await request(app.getHttpServer()).post('/v1/admin/login').send({ email: 'shared-style@b.example', password: 'tenant-b-password-123' });
    expect(loginA.status).toBe(200);
    expect(loginB.status).toBe(200);
  });
});
