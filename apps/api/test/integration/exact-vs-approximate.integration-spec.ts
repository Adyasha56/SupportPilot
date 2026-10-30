/**
 * Proves retrieve({ exact: true }) (ENN) and the default retrieve({})
 * (ANN) agree on a small corpus, and that every result from both paths has
 * a score within [0, 1] - not just the single result checked in
 * policy-lifecycle.integration-spec.ts's happy path.
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

describe.skipIf(!integrationTestsEnabled())('Exact vs approximate search agreement (integration, real database)', () => {
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
    'returns the same set of chunks (exact == approximate) on a small corpus, every score within [0, 1]',
    async () => {
      const tenant = await createTenantFixture(uri);
      createdTenants.push(tenant.tenantId);
      const topic = `agreementcheck${Date.now()}`;

      // Each section's body must be well over ~400 characters (the
      // chunker's default 100-token merge floor, approxTokens ~= chars/4 -
      // see markdown-chunker.ts's mergeTinySections) or same-parent
      // sibling sections get merged into one chunk regardless of heading
      // count. A short one-line body (the original version of this test)
      // produced exactly 1 merged chunk instead of 6 - confirmed by
      // reading mergeTinySections directly, not assumed.
      const sectionBody = (i: number): string =>
        `${topic} appears here in section ${i} as part of a longer passage with enough unique content of its own that this section stays distinct from its neighbors during chunking and is never merged with them. `.repeat(
          4,
        );
      const sections = Array.from({ length: 6 }, (_, i) => `# Section ${i}\n\n${sectionBody(i)}`).join('\n\n');

      const uploadRes = await request(app.getHttpServer())
        .post('/v1/policies')
        .set('Authorization', `Bearer ${tenant.secretKey}`)
        .attach('file', Buffer.from(sections), 'multi-section.md');
      expect(uploadRes.status).toBe(201);
      expect(uploadRes.body.chunkCount).toBeGreaterThanOrEqual(6);
      const documentId = uploadRes.body.id as string;

      const retrievalService = app.get(PolicyRetrievalService);
      await pollUntil(async () => {
        const result = await retrievalService.retrieve(tenant.tenantId, topic, { topK: 6, exact: true });
        return result.ok && result.results.some((r) => r.documentId === documentId) ? result : undefined;
      }, "the multi-section document's chunks becoming searchable");

      const exactResult = await retrievalService.retrieve(tenant.tenantId, topic, { topK: 6, exact: true });
      const approxResult = await retrievalService.retrieve(tenant.tenantId, topic, { topK: 6, exact: false });

      expect(exactResult.ok).toBe(true);
      expect(approxResult.ok).toBe(true);
      if (!exactResult.ok || !approxResult.ok) {
        return;
      }

      expect(exactResult.results.length).toBeGreaterThan(0);
      expect(approxResult.results.length).toBeGreaterThan(0);

      const exactKeys = new Set(exactResult.results.map((r) => r.chunkKey));
      const approxKeys = new Set(approxResult.results.map((r) => r.chunkKey));
      expect(approxKeys).toEqual(exactKeys);

      for (const result of [...exactResult.results, ...approxResult.results]) {
        expect(result.score).toBeGreaterThanOrEqual(0);
        expect(result.score).toBeLessThanOrEqual(1);
      }
    },
    90_000,
  );
});
