/**
 * Proves, against the real database and the real commit path (not a fake
 * TransactionRunner), that an embedding failure partway through a
 * multi-batch document leaves zero active chunks and a `failed` document -
 * never a partially-committed one. The commit-failure path itself (a
 * transaction aborting after embedding succeeds) is already covered by a
 * unit test with a throwing fake (policy-ingestion.service.spec.ts) and by
 * the real-cluster transaction proof in src/scripts/check-transactions.ts
 * (see docs/learning-notes.md) - not re-derived here to avoid claiming a
 * second, separate proof of the same fact.
 *
 * Needs its own app instance (not the shared one in
 * policy-lifecycle.integration-spec.ts): INGESTION_EMBEDDING_BATCH_SIZE is
 * forced to 1 so a 2-chunk document spans two embed() calls, and
 * LLM_PROVIDER is overridden with a provider that fails on the SECOND call.
 */
import './test-env';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AppModule } from '../../src/app.module';
import { LLM_PROVIDER } from '../../src/llm/llm.module';
import { EmbedOutcome, EmbeddingTaskType, LlmProvider } from '../../src/llm/llm-provider.interface';
import { FakeLlmProvider } from '../../src/llm/test-utils/fake-llm-provider';
import { cleanupTenant, createTenantFixture, disconnectFixtureConnection } from './tenant-fixture';
import { getTestMongoUri, integrationTestsEnabled } from './test-env';

class FailsOnSecondCallLlmProvider implements LlmProvider {
  private calls = 0;
  private readonly inner = new FakeLlmProvider();

  async embed(texts: string[], taskType: EmbeddingTaskType): Promise<EmbedOutcome> {
    this.calls += 1;
    if (this.calls === 2) {
      return { ok: false, error: { code: 'TRANSIENT', message: 'simulated mid-pipeline failure' } };
    }
    return this.inner.embed(texts, taskType);
  }
}

describe.skipIf(!integrationTestsEnabled())('Embedding failure mid-pipeline (integration, real database)', () => {
  let app: INestApplication;
  const uri = integrationTestsEnabled() ? getTestMongoUri() : '';
  const createdTenants: string[] = [];

  beforeAll(async () => {
    process.env.INGESTION_EMBEDDING_BATCH_SIZE = '1';

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(LLM_PROVIDER)
      .useClass(FailsOnSecondCallLlmProvider)
      .compile();
    app = moduleRef.createNestApplication();
    await app.init();
  }, 150_000);

  afterAll(async () => {
    delete process.env.INGESTION_EMBEDDING_BATCH_SIZE;
    await Promise.all(createdTenants.map((tenantId) => cleanupTenant(uri, tenantId)));
    await app.close();
    await disconnectFixtureConnection();
  });

  it('commits zero chunks and marks the document failed when the second embedding batch fails', async () => {
    const tenant = await createTenantFixture(uri);
    createdTenants.push(tenant.tenantId);

    // Two headings -> two chunks -> two embeddingBatchSize=1 batches - the
    // second one is the one FailsOnSecondCallLlmProvider rejects. Each
    // section's body must be well over ~400 characters (the chunker's
    // default 100-token merge floor, approxTokens ~= chars/4 - see
    // markdown-chunker.ts's mergeTinySections) or the two same-parent
    // sections get merged into a single chunk and only one embed() call
    // ever happens - confirmed directly by reading mergeTinySections, not
    // assumed (a short one-line body, the original version of this test,
    // produced exactly 1 chunk and the upload wrongly succeeded).
    const longBody = (label: string): string =>
      `${label} body text with enough unique content of its own that this section stays distinct from its sibling during chunking and is never merged with it. `.repeat(
        4,
      );
    const markdown = `# First section\n\n${longBody('First section')}\n\n# Second section\n\n${longBody('Second section')}`;

    const res = await request(app.getHttpServer())
      .post('/v1/policies')
      .set('Authorization', `Bearer ${tenant.secretKey}`)
      .attach('file', Buffer.from(markdown), 'two-sections.md');

    expect(res.status).toBe(502);
    expect(res.body.code).toBe('EMBEDDING_FAILED');

    const listRes = await request(app.getHttpServer())
      .get('/v1/policies')
      .set('Authorization', `Bearer ${tenant.secretKey}`);
    expect(listRes.status).toBe(200);
    expect(listRes.body).toHaveLength(1);
    expect(listRes.body[0].status).toBe('failed');
    expect(listRes.body[0].failureCode).toBe('EMBEDDING_FAILED');
    expect(listRes.body[0].chunkCount).toBe(0);
  });
});
