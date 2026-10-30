/**
 * The two-tenant isolation test in policy-lifecycle.integration-spec.ts
 * proves tenant A never sees tenant B's chunks, but doesn't prove isolation
 * was actually load-bearing - if B's chunk would never have ranked above
 * A's own chunk anyway, the filter was never under real pressure. This file
 * adds the positive control: a RAW, UNFILTERED vector search (no tenantId
 * filter, no active filter - built only in this test file, never in
 * production code) proves tenant B's chunk is the single nearest match
 * across ALL tenants for the query, and only then checks that tenant A's
 * real, filtered retrieve() still returns none of it - while tenant B's
 * own retrieve() does return it, so a passing result can't be an
 * always-empty bug in disguise.
 */
import './test-env';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import { getModelToken } from '@nestjs/mongoose';
import type { Model, PipelineStage } from 'mongoose';
import { bootApp } from './app-harness';
import { cleanupTenant, createTenantFixture, disconnectFixtureConnection } from './tenant-fixture';
import { getTestMongoUri, integrationTestsEnabled } from './test-env';
import { pollUntil } from './poll';
import { PolicyRetrievalService, RetrieveOutcome } from '../../src/retrieval/policy-retrieval.service';
import { POLICY_CHUNK_VECTOR_INDEX_NAME } from '../../src/db/schemas/policy-chunk.schema';
import { FakeLlmProvider } from '../../src/llm/test-utils/fake-llm-provider';

/** -1 is a safe "nothing" floor: every real score is in [0, 1] (see the score-bound checks elsewhere), so any real score beats it. */
function bestOwnScore(outcome: RetrieveOutcome): number {
  return outcome.ok && outcome.results.length > 0 ? outcome.results[0].score : -1;
}

interface RawSearchHit {
  tenantId: string;
  score: number;
}

/**
 * TEST-ONLY raw pipeline: no tenantId filter, no active filter - the exact
 * opposite of buildVectorSearchPipeline() in policy-chunk.repository.ts.
 * This must never be copied into production code; it exists only to prove
 * what the search would return with no isolation at all, as the positive
 * control for the real, filtered retrieve() call that follows it.
 */
function rawUnfilteredSearchPipeline(queryVector: number[], limit: number): PipelineStage[] {
  return [
    { $vectorSearch: { index: POLICY_CHUNK_VECTOR_INDEX_NAME, path: 'embedding', queryVector, limit, exact: true } },
    { $project: { _id: 0, tenantId: 1, score: { $meta: 'vectorSearchScore' } } },
  ];
}

describe.skipIf(!integrationTestsEnabled())('Tenant isolation, adversarial case with a positive control (integration)', () => {
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
    "never returns tenant B's chunk to tenant A, even when B's chunk is the single nearest match across all tenants",
    async () => {
      const tenantA = await createTenantFixture(uri);
      const tenantB = await createTenantFixture(uri);
      createdTenants.push(tenantA.tenantId, tenantB.tenantId);

      const queryText = `exactmatchprobe${Date.now()}`;
      // A's content shares no words with the query - deliberately a weak
      // match. B's content IS the query text, verbatim - the closest match
      // any chunk could plausibly have to this query. Deliberately no
      // claim about the exact score this produces (buildEmbeddingText()
      // prepends headingPath before embedding, so it's not a pure text
      // match either) - the test below proves the relative ordering this
      // setup is meant to create, not a specific number.
      const uploadA = await request(app.getHttpServer())
        .post('/v1/policies')
        .set('Authorization', `Bearer ${tenantA.secretKey}`)
        .attach('file', Buffer.from('# Unrelated\n\nCompletely unrelated filler content about shipping boxes.'), 'a.md');
      const uploadB = await request(app.getHttpServer())
        .post('/v1/policies')
        .set('Authorization', `Bearer ${tenantB.secretKey}`)
        .attach('file', Buffer.from(`# Exact\n\n${queryText}`), 'b.md');
      expect(uploadA.status).toBe(201);
      expect(uploadB.status).toBe(201);

      const retrievalService = app.get(PolicyRetrievalService);
      const retrieveForTenant = (tenantId: string) => retrievalService.retrieve(tenantId, queryText, { exact: true });

      await pollUntil(async () => {
        const b = await retrieveForTenant(tenantB.tenantId);
        return b.ok && b.results.length > 0 ? b : undefined;
      }, "tenant B's chunk becoming searchable");

      // --- The real guarantee: A's own, tenant-filtered retrieve() never sees B's chunk. ---
      const resultA = await retrieveForTenant(tenantA.tenantId);
      expect(resultA.ok).toBe(true);
      if (resultA.ok) {
        expect(resultA.results.every((r) => r.documentId !== uploadB.body.id)).toBe(true);
      }

      // --- Not an always-empty bug: B's own retrieve() does return it. ---
      const resultB = await retrieveForTenant(tenantB.tenantId);
      expect(resultB.ok).toBe(true);
      if (resultB.ok) {
        expect(resultB.results.some((r) => r.documentId === uploadB.body.id)).toBe(true);
      }

      // --- Positive control: prove isolation was actually load-bearing. ---
      // Relative, not absolute: the raw, unfiltered top hit belongs to B,
      // AND its score beats A's own best real match - no magic number tied
      // to the fake embedder's specific arithmetic (buildEmbeddingText()
      // prepending headingPath makes an exact score unpredictable without
      // reading chunking internals, and relying on one makes the test
      // brittle to future chunking changes for no real gain - the relative
      // claim is the only thing that actually matters here).
      const embedOutcome = await new FakeLlmProvider().embed([queryText], 'RETRIEVAL_QUERY');
      if (!embedOutcome.ok) {
        throw new Error('FakeLlmProvider.embed() never fails - this cannot happen.');
      }
      const queryVector = embedOutcome.result.vectors[0].values;
      const chunkModel = app.get<Model<unknown>>(getModelToken('PolicyChunk'));
      const rawHits = await chunkModel.aggregate<RawSearchHit>(rawUnfilteredSearchPipeline(queryVector, 5));
      expect(rawHits.length).toBeGreaterThan(0);
      expect(rawHits[0].tenantId).toBe(tenantB.tenantId);

      const aBestScore = bestOwnScore(resultA);
      expect(
        rawHits[0].score,
        `B's raw top score (${rawHits[0].score}) was not greater than A's best own score (${aBestScore}) - ` +
          'the positive control requires B to genuinely outrank A, not just exist.',
      ).toBeGreaterThan(aBestScore);
    },
    90_000,
  );
});
