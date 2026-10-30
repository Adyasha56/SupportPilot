/**
 * Isolates deactivation from the rest of the delete flow: calls
 * chunkRepository.deactivateForDocument() directly (the real repository,
 * real database), WITHOUT ever calling deleteForDocument(), then calls
 * retrieve() immediately afterward with NO polling. This is the specific
 * case the Stage 6 follow-up diagnosed and fixed (see
 * docs/learning-notes.md's deactivation-leak entry): the chunk still
 * exists in the collection, only its `active` field changed, and the
 * $vectorSearch pre-filter's own copy of that field is allowed to lag -
 * this test proves PolicyRetrievalService's post-search re-check still
 * closes that gap with zero wait.
 */
import './test-env';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import { bootApp } from './app-harness';
import { cleanupTenant, createTenantFixture, disconnectFixtureConnection } from './tenant-fixture';
import { getTestMongoUri, integrationTestsEnabled } from './test-env';
import { pollUntil } from './poll';
import { PolicyRetrievalService } from '../../src/retrieval/policy-retrieval.service';
import { POLICY_CHUNK_REPOSITORY, PolicyChunkRepository } from '../../src/db/policy-chunk.repository';

describe.skipIf(!integrationTestsEnabled())('Deactivation without deletion (integration, real database)', () => {
  let app: INestApplication;
  let close: () => Promise<void>;
  const uri = integrationTestsEnabled() ? getTestMongoUri() : '';
  const createdTenants: string[] = [];

  beforeAll(async () => {
    const harness = await bootApp();
    app = harness.app;
    close = harness.close;
  }, 150_000);

  afterAll(async () => {
    await Promise.all(createdTenants.map((tenantId) => cleanupTenant(uri, tenantId)));
    await close();
    await disconnectFixtureConnection();
  });

  it(
    'returns zero results immediately (no polling) after deactivateForDocument(), with the chunk still physically present',
    async () => {
      const tenant = await createTenantFixture(uri);
      createdTenants.push(tenant.tenantId);
      const uniqueWord = `deactivateonly${Date.now()}`;

      const uploadRes = await request(app.getHttpServer())
        .post('/v1/policies')
        .set('Authorization', `Bearer ${tenant.secretKey}`)
        .attach('file', Buffer.from(`# Policy\n\nText mentioning ${uniqueWord} for this test only.`), 'policy.md');
      expect(uploadRes.status).toBe(201);
      const documentId = uploadRes.body.id as string;

      const retrievalService = app.get(PolicyRetrievalService);
      const chunkRepository = app.get<PolicyChunkRepository>(POLICY_CHUNK_REPOSITORY);

      await pollUntil(async () => {
        const result = await retrievalService.retrieve(tenant.tenantId, uniqueWord);
        return result.ok && result.results.some((r) => r.documentId === documentId) ? result : undefined;
      }, "the chunk becoming searchable before it's deactivated");

      await chunkRepository.deactivateForDocument(tenant.tenantId, documentId);

      // No pollUntil here, deliberately - a single, immediate retrieve()
      // call, exactly as PolicyRetrievalService's own defense-in-depth
      // comment claims is safe.
      const afterDeactivate = await retrievalService.retrieve(tenant.tenantId, uniqueWord);
      expect(afterDeactivate.ok).toBe(true);
      if (afterDeactivate.ok) {
        expect(afterDeactivate.results.some((r) => r.documentId === documentId)).toBe(false);
      }

      // The chunk is still physically there - this proves the zero result
      // above came from the active-state check, not from the chunk simply
      // not existing (which deleteForDocument(), never called here, would cause).
      const countAfterDeactivate = await chunkRepository.countForTenant(tenant.tenantId);
      expect(countAfterDeactivate).toBeGreaterThan(0);
    },
    90_000,
  );
});
