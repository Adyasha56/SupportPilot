/**
 * Milestone 5, Stage 1c, item 6 - `GET /v1/conversations` and
 * `GET /v1/conversations/:id` through the REAL AppModule (real
 * AdminAuthGuard, real Mongoose repositories) - the controller-level spec
 * (conversations-admin.controller.spec.ts) already proves the response
 * shape and citation resolution against in-memory fakes; this proves the
 * same routes work end to end against a real database, with an admin key,
 * with a session, and that secret/public keys and tenant isolation hold
 * for real.
 */
import './test-env';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../../src/app.module';
import {
  cleanupTenant,
  createAdminCredentialFixture,
  createApiKeyFixture,
  createConversationWithRunFixture,
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
  if (!integrationTestsEnabled()) return;
  await Promise.all(allCreatedTenants.map((tenantId) => cleanupTenant(uri, tenantId)));
  await disconnectFixtureConnection();
});

describe.skipIf(!integrationTestsEnabled())('Conversations admin console (integration, real database)', () => {
  let app: INestApplication;
  let priorDevCookieEnv: string | undefined;

  // Same dev-cookie dance as admin-auth.integration-spec.ts's own beforeAll - the PRODUCTION
  // session cookie is Secure, which superagent's cookie jar refuses to resend over this test's
  // plain-HTTP transport without it. Must be set before AppModule's compile() reads it.
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

  it('an ADMIN-scoped API key can list and fetch a real conversation, with its real AgentRun', async () => {
    const tenant = await newTenant();
    const adminKey = await createApiKeyFixture(uri, tenant.tenantId, 'admin');
    const { conversationId, runId } = await createConversationWithRunFixture(uri, tenant.tenantId, 'cust_real_12345');

    const list = await request(app.getHttpServer()).get('/v1/conversations').set('Authorization', `Bearer ${adminKey.rawKey}`);
    expect(list.status).toBe(200);
    expect(list.body.conversations.map((c: { id: string }) => c.id)).toContain(conversationId);

    const detail = await request(app.getHttpServer()).get(`/v1/conversations/${conversationId}`).set('Authorization', `Bearer ${adminKey.rawKey}`);
    expect(detail.status).toBe(200);
    expect(detail.body.customerRef).toBe('cust_real_12345');
    expect(detail.body.messages).toHaveLength(2);
    expect(detail.body.runs).toHaveLength(1);
    expect(detail.body.runs[0].runId).toBe(runId);
  });

  it('a cookie-authenticated session can also list and fetch, with no API key at all', async () => {
    const tenant = await newTenant();
    await createAdminCredentialFixture(uri, tenant.tenantId, `convo-session-${tenant.tenantId}@example.com`, 'a-real-password-123456');
    const { conversationId } = await createConversationWithRunFixture(uri, tenant.tenantId);

    const agent = request.agent(app.getHttpServer());
    await agent.post('/v1/admin/login').send({ email: `convo-session-${tenant.tenantId}@example.com`, password: 'a-real-password-123456' });

    const detail = await agent.get(`/v1/conversations/${conversationId}`);
    expect(detail.status).toBe(200);
  });

  it('a SECRET-scoped key is rejected, identically to a public key - admin is required', async () => {
    const tenant = await newTenant();
    const res = await request(app.getHttpServer()).get('/v1/conversations').set('Authorization', `Bearer ${tenant.secretKey}`);
    expect(res.status).toBe(401);
  });

  it("tenant isolation: tenant B's admin key gets an identical 404 for tenant A's conversation id", async () => {
    const tenantA = await newTenant();
    const tenantB = await newTenant();
    const adminKeyB = await createApiKeyFixture(uri, tenantB.tenantId, 'admin');
    const { conversationId } = await createConversationWithRunFixture(uri, tenantA.tenantId);

    const notFoundForOther = await request(app.getHttpServer()).get(`/v1/conversations/${conversationId}`).set('Authorization', `Bearer ${adminKeyB.rawKey}`);
    const notFoundForMissing = await request(app.getHttpServer())
      .get('/v1/conversations/totally-made-up-id')
      .set('Authorization', `Bearer ${adminKeyB.rawKey}`);

    expect(notFoundForOther.status).toBe(404);
    expect(notFoundForMissing.status).toBe(404);
    expect(notFoundForOther.body).toEqual(notFoundForMissing.body);
  });
});
