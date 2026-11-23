/**
 * Milestone 5, Stage 1c, item 6 - "policies upload and delete via a
 * session with CSRF." `policy-lifecycle.integration-spec.ts` already
 * covers the full upload/ingest/delete pipeline through a SECRET-scoped
 * API key (unchanged by Stage 1c item 1's AdminAuthGuard migration); this
 * file is specifically the NEW path - a cookie-authenticated admin
 * session, through the real AppModule, uploading and deleting a real
 * document with the CSRF token attached. A dedicated harness (not
 * app-harness.ts's shared `bootApp()`) because this needs
 * `ADMIN_DEV_COOKIE_ENABLED` set before AppModule's own compile() reads
 * it - the same requirement every other session-based integration spec in
 * this stage has, and not something worth adding to the shared harness
 * every OTHER integration spec also uses.
 */
import './test-env';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../../src/app.module';
import { LLM_PROVIDER } from '../../src/llm/llm.module';
import { FakeLlmProvider } from '../../src/llm/test-utils/fake-llm-provider';
import { cleanupTenant, createAdminCredentialFixture, createTenantFixture, disconnectFixtureConnection, TenantFixture } from './tenant-fixture';
import { getTestMongoUri, integrationTestsEnabled } from './test-env';

const uri = integrationTestsEnabled() ? getTestMongoUri() : '';
const allCreatedTenants: string[] = [];
const SAMPLE_MARKDOWN = '# Refund Policy\n\nRefunds are issued within 30 days of purchase, no exceptions apply here at all.';

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

describe.skipIf(!integrationTestsEnabled())('Policies via an admin session, with CSRF (integration, real database)', () => {
  let app: INestApplication;
  let priorDevCookieEnv: string | undefined;

  beforeAll(async () => {
    priorDevCookieEnv = process.env.ADMIN_DEV_COOKIE_ENABLED;
    process.env.ADMIN_DEV_COOKIE_ENABLED = 'true';
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).overrideProvider(LLM_PROVIDER).useClass(FakeLlmProvider).compile();
    app = moduleRef.createNestApplication();
    await app.init();
  }, 60_000);

  afterAll(async () => {
    await app.close();
    if (priorDevCookieEnv === undefined) delete process.env.ADMIN_DEV_COOKIE_ENABLED;
    else process.env.ADMIN_DEV_COOKIE_ENABLED = priorDevCookieEnv;
  });

  it('a session can upload a policy document WITH the CSRF header, and the multipart body is unaffected by it', async () => {
    const tenant = await newTenant();
    const email = `policy-session-${tenant.tenantId}@example.com`;
    await createAdminCredentialFixture(uri, tenant.tenantId, email, 'a-real-password-123456');

    const agent = request.agent(app.getHttpServer());
    await agent.post('/v1/admin/login').send({ email, password: 'a-real-password-123456' });
    const bootstrap = await agent.get('/v1/admin/session');
    const csrfToken = bootstrap.body.csrfToken as string;

    const upload = await agent
      .post('/v1/policies')
      .set('x-csrf-token', csrfToken)
      .field('title', 'Session Upload Policy')
      .attach('file', Buffer.from(SAMPLE_MARKDOWN), 'policy.md');

    expect(upload.status).toBe(201);
    expect(upload.body.status).toBe('ready');
  });

  it('a session upload WITHOUT the CSRF header is rejected - the multipart body never bypasses the guard', async () => {
    const tenant = await newTenant();
    const email = `policy-session-nocsrf-${tenant.tenantId}@example.com`;
    await createAdminCredentialFixture(uri, tenant.tenantId, email, 'a-real-password-123456');

    const agent = request.agent(app.getHttpServer());
    await agent.post('/v1/admin/login').send({ email, password: 'a-real-password-123456' });

    const upload = await agent.post('/v1/policies').field('title', 'Should Not Work').attach('file', Buffer.from(SAMPLE_MARKDOWN), 'policy.md');
    expect(upload.status).toBe(401);
  });

  it('a session can delete a policy document WITH the CSRF header', async () => {
    const tenant = await newTenant();
    const email = `policy-session-delete-${tenant.tenantId}@example.com`;
    await createAdminCredentialFixture(uri, tenant.tenantId, email, 'a-real-password-123456');

    const agent = request.agent(app.getHttpServer());
    await agent.post('/v1/admin/login').send({ email, password: 'a-real-password-123456' });
    const bootstrap = await agent.get('/v1/admin/session');
    const csrfToken = bootstrap.body.csrfToken as string;

    const upload = await agent
      .post('/v1/policies')
      .set('x-csrf-token', csrfToken)
      .field('title', 'To Be Deleted')
      .attach('file', Buffer.from(SAMPLE_MARKDOWN), 'policy.md');
    expect(upload.status).toBe(201);

    const del = await agent.delete(`/v1/policies/${upload.body.id}`).set('x-csrf-token', csrfToken);
    expect(del.status).toBe(204);

    const list = await agent.get('/v1/policies');
    expect(list.body.find((d: { id: string }) => d.id === upload.body.id)).toBeUndefined();
  });
});
