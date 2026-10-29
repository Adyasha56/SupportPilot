/**
 * Stage 7 integration suite: boots the REAL AppModule against the one
 * fixed test database (MONGODB_TEST_URI), with only LLM_PROVIDER faked
 * (see app-harness.ts). Converts the retrieval-smoke-script's manual
 * checks into automated, repeatable tests, plus the upload-path checks
 * the smoke script never covered (duplicates, bad extension, auth).
 *
 * Skipped entirely (not failed) when MONGODB_TEST_URI is unset - see
 * test-env.ts. Every test cleans up its own tenant in a finally block, by
 * tenantId only, never dropDatabase - this database is shared by the whole
 * suite (and, per Stage 7 item 5, may be a developer's own Atlas cluster).
 */
import './test-env';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import { bootApp } from './app-harness';
import { ensureTestIndexes } from './ensure-test-indexes';
import { cleanupTenant, createApiKeyFixture, createTenantFixture, disconnectFixtureConnection, TenantFixture } from './tenant-fixture';
import { getTestMongoUri, integrationTestsEnabled } from './test-env';
import { pollUntil } from './poll';
import { PolicyRetrievalService } from '../../src/retrieval/policy-retrieval.service';
import { API_KEY_REPOSITORY, ApiKeyRepository } from '../../src/db/api-key.repository';

describe.skipIf(!integrationTestsEnabled())('Policy lifecycle (integration, real database)', () => {
  let app: INestApplication;
  let close: () => Promise<void>;
  const uri = integrationTestsEnabled() ? getTestMongoUri() : '';
  const createdTenants: string[] = [];

  beforeAll(async () => {
    await ensureTestIndexes(uri, (message) => console.log(`[ensure-test-indexes] ${message}`));
    const harness = await bootApp();
    app = harness.app;
    close = harness.close;
  }, 150_000);

  afterAll(async () => {
    await Promise.all(createdTenants.map((tenantId) => cleanupTenant(uri, tenantId)));
    await close();
    await disconnectFixtureConnection();
  });

  async function newTenant(): Promise<TenantFixture> {
    const fixture = await createTenantFixture(uri);
    createdTenants.push(fixture.tenantId);
    return fixture;
  }

  async function retrieveViaService(tenantId: string, query: string) {
    const service = app.get(PolicyRetrievalService);
    return service.retrieve(tenantId, query);
  }

  it(
    'uploads a policy, retrieves it once searchable, then deletes it and confirms it is gone',
    async () => {
      const tenant = await newTenant();
      const uniqueWord = `zzyzxlexeme${Date.now()}`;
      const markdown = `# Refund policy\n\nOrders mentioning ${uniqueWord} are always refundable within 30 days.`;

      const uploadRes = await request(app.getHttpServer())
        .post('/v1/policies')
        .set('Authorization', `Bearer ${tenant.secretKey}`)
        .attach('file', Buffer.from(markdown), 'refund-policy.md')
        .field('title', 'Refund policy');

      expect(uploadRes.status).toBe(201);
      expect(uploadRes.body.status).toBe('ready');
      expect(uploadRes.body.chunkCount).toBeGreaterThan(0);
      const documentId = uploadRes.body.id as string;

      const found = await pollUntil(
        async () => {
          const result = await retrieveViaService(tenant.tenantId, uniqueWord);
          if (result.ok && result.results.some((r) => r.documentId === documentId)) {
            return result;
          }
          return undefined;
        },
        `tenant ${tenant.tenantId}'s just-uploaded chunk becoming searchable for "${uniqueWord}"`,
      );
      expect(found.ok).toBe(true);
      if (found.ok) {
        expect(found.results[0].documentTitle).toBe('Refund policy');
        expect(found.results[0].score).toBeGreaterThanOrEqual(0);
        expect(found.results[0].score).toBeLessThanOrEqual(1);
      }

      const deleteRes = await request(app.getHttpServer())
        .delete(`/v1/policies/${documentId}`)
        .set('Authorization', `Bearer ${tenant.secretKey}`);
      expect(deleteRes.status).toBe(204);

      // Deactivation is immediate (no polling needed) - see the defense-in-depth
      // comment in policy-retrieval.service.ts: the re-check after search uses
      // the chunk's own live `active` field, not the index's lagging copy.
      const afterDelete = await retrieveViaService(tenant.tenantId, uniqueWord);
      expect(afterDelete.ok).toBe(true);
      if (afterDelete.ok) {
        expect(afterDelete.results.some((r) => r.documentId === documentId)).toBe(false);
      }
    },
    90_000,
  );

  it('rejects a duplicate upload with 409 and the existing document id', async () => {
    const tenant = await newTenant();
    const markdown = '# Shipping policy\n\nStandard shipping takes 5 to 7 business days.';

    const first = await request(app.getHttpServer())
      .post('/v1/policies')
      .set('Authorization', `Bearer ${tenant.secretKey}`)
      .attach('file', Buffer.from(markdown), 'shipping.md');
    expect(first.status).toBe(201);

    const second = await request(app.getHttpServer())
      .post('/v1/policies')
      .set('Authorization', `Bearer ${tenant.secretKey}`)
      .attach('file', Buffer.from(markdown), 'shipping-again.md');
    expect(second.status).toBe(409);
    expect(second.body.code).toBe('DUPLICATE_CONTENT');
    expect(second.body.existingDocumentId).toBe(first.body.id);
  });

  it('rejects a disallowed file extension with 422', async () => {
    const tenant = await newTenant();
    const res = await request(app.getHttpServer())
      .post('/v1/policies')
      .set('Authorization', `Bearer ${tenant.secretKey}`)
      .attach('file', Buffer.from('<html></html>'), 'policy.html');
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('INVALID_FILE_TYPE');
  });

  it('returns an identical generic 401 for a missing, malformed, and wrong-scope key', async () => {
    const tenant = await newTenant();

    const missing = await request(app.getHttpServer()).get('/v1/policies');
    const malformed = await request(app.getHttpServer()).get('/v1/policies').set('Authorization', 'not-a-bearer-token');
    const wrongScope = await request(app.getHttpServer()).get('/v1/policies').set('Authorization', `Bearer ${tenant.publicKey}`);

    expect(missing.status).toBe(401);
    expect(malformed.status).toBe(401);
    expect(wrongScope.status).toBe(401);
    expect(missing.body).toEqual(malformed.body);
    expect(missing.body).toEqual(wrongScope.body);
  });

  it('returns the identical generic 401 for a key revoked through the real ApiKeyRepository', async () => {
    const tenant = await newTenant();
    const revocable = await createApiKeyFixture(uri, tenant.tenantId, 'secret');

    // Sanity check first - the key must actually work before revocation,
    // otherwise a 401 afterward would prove nothing about revocation itself.
    const beforeRevoke = await request(app.getHttpServer()).get('/v1/policies').set('Authorization', `Bearer ${revocable.rawKey}`);
    expect(beforeRevoke.status).toBe(200);

    const apiKeyRepository = app.get<ApiKeyRepository>(API_KEY_REPOSITORY);
    const revoked = await apiKeyRepository.revoke(revocable.id);
    expect(revoked).toBe(true);

    const afterRevoke = await request(app.getHttpServer()).get('/v1/policies').set('Authorization', `Bearer ${revocable.rawKey}`);
    const missing = await request(app.getHttpServer()).get('/v1/policies');

    expect(afterRevoke.status).toBe(401);
    expect(afterRevoke.body).toEqual(missing.body);
  });

  it(
    'never returns another tenant\'s chunks, even for the closest-matching query',
    async () => {
      const tenantA = await newTenant();
      const tenantB = await newTenant();
      const sharedWord = `isolationcheck${Date.now()}`;

      const uploadA = await request(app.getHttpServer())
        .post('/v1/policies')
        .set('Authorization', `Bearer ${tenantA.secretKey}`)
        .attach('file', Buffer.from(`# A policy\n\n${sharedWord} belongs only to tenant A.`), 'a.md');
      const uploadB = await request(app.getHttpServer())
        .post('/v1/policies')
        .set('Authorization', `Bearer ${tenantB.secretKey}`)
        .attach('file', Buffer.from(`# B policy\n\n${sharedWord} belongs only to tenant B.`), 'b.md');
      expect(uploadA.status).toBe(201);
      expect(uploadB.status).toBe(201);

      await pollUntil(async () => {
        const a = await retrieveViaService(tenantA.tenantId, sharedWord);
        const b = await retrieveViaService(tenantB.tenantId, sharedWord);
        if (a.ok && b.ok && a.results.length > 0 && b.results.length > 0) {
          return { a, b };
        }
        return undefined;
      }, 'both tenants\' chunks becoming searchable');

      const resultA = await retrieveViaService(tenantA.tenantId, sharedWord);
      const resultB = await retrieveViaService(tenantB.tenantId, sharedWord);
      expect(resultA.ok).toBe(true);
      expect(resultB.ok).toBe(true);
      if (resultA.ok && resultB.ok) {
        expect(resultA.results.every((r) => r.documentId === uploadA.body.id)).toBe(true);
        expect(resultB.results.every((r) => r.documentId === uploadB.body.id)).toBe(true);
      }
    },
    90_000,
  );
});
