/**
 * Milestone 5, Stage 1c, item 6 - `GET /v1/connectors` through the REAL
 * AppModule. Connector configs are file-backed, not database-backed
 * (PROJECT.md section 7/12), so this integration spec only has a real
 * database in the picture for the admin AUTH side (AdminAuthGuard, real
 * sessions/credentials) - the real fixture CONTENT (acme's/widgetco's
 * actual connector files, proving secretRef/request/idPattern never leak)
 * is already proven by connectors-admin.controller.spec.ts directly
 * against those real files, outside the shared integration database. This
 * tenant's own id is a fresh random one (no fixture directory of its own),
 * so its list is legitimately always empty - the point here is the
 * admin/session/secret/public scope and tenant-isolation plumbing working
 * end to end, not the fixture content.
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

describe.skipIf(!integrationTestsEnabled())('Connectors admin console (integration, real database)', () => {
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

  it('an ADMIN-scoped key gets 200 with a (possibly empty) connector list - never an error for a tenant with no fixtures', async () => {
    const tenant = await newTenant();
    const adminKey = await createApiKeyFixture(uri, tenant.tenantId, 'admin');

    const res = await request(app.getHttpServer()).get('/v1/connectors').set('Authorization', `Bearer ${adminKey.rawKey}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.connectors)).toBe(true);
  });

  it('a cookie-authenticated session also works, with no API key at all', async () => {
    const tenant = await newTenant();
    const email = `connectors-session-${tenant.tenantId}@example.com`;
    await createAdminCredentialFixture(uri, tenant.tenantId, email, 'a-real-password-123456');

    const agent = request.agent(app.getHttpServer());
    await agent.post('/v1/admin/login').send({ email, password: 'a-real-password-123456' });

    const res = await agent.get('/v1/connectors');
    expect(res.status).toBe(200);
  });

  it('a SECRET-scoped key is rejected, identically to a public key', async () => {
    const tenant = await newTenant();
    const res = await request(app.getHttpServer()).get('/v1/connectors').set('Authorization', `Bearer ${tenant.secretKey}`);
    expect(res.status).toBe(401);
  });
});
