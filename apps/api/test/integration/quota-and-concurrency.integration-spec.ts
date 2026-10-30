/**
 * Quota (DOCUMENT_QUOTA_EXCEEDED, CHUNK_QUOTA_EXCEEDED) and concurrency
 * (TENANT_BUSY) checks against the real database. Two separate app
 * instances, each with its own env override, so neither test's setup
 * interferes with the other's:
 *  - quotaApp: INGESTION_MAX_DOCUMENTS_PER_TENANT / INGESTION_MAX_CHUNKS_PER_TENANT
 *    forced small, so a quota can actually be hit without uploading
 *    dozens of real documents.
 *  - gatedApp: LLM_PROVIDER overridden with a provider whose embed() call
 *    blocks on a manually-released gate, so the TENANT_BUSY race is
 *    deterministic - no sleep, no timing guess. The lock is acquired
 *    BEFORE embedding happens (see ingestion.ts's ingest()), so holding
 *    embed() open holds the lock open.
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

class GatedLlmProvider implements LlmProvider {
  private readonly inner = new FakeLlmProvider();
  private releaseGate: (() => void) | undefined;
  private gatePromise: Promise<void> | undefined;
  private resolveEntered: (() => void) | undefined;
  private enteredPromise: Promise<void> | undefined;

  /** Call BEFORE the request that should block - sets up a gate embed() will wait on. */
  hold(): void {
    this.gatePromise = new Promise((resolve) => {
      this.releaseGate = resolve;
    });
    this.enteredPromise = new Promise((resolve) => {
      this.resolveEntered = resolve;
    });
  }

  /**
   * Resolves the instant embed() is actually called and gated - an
   * explicit signal from the provider itself, not a timing guess. The
   * previous version of this test used a single setImmediate tick to
   * assume request 1 had reached the lock before firing request 2; that
   * assumption wasn't guaranteed under real network/multer overhead and
   * the test hung for the full 90s timeout in CI instead of failing fast.
   */
  waitUntilEntered(): Promise<void> {
    if (!this.enteredPromise) {
      throw new Error('hold() must be called before waitUntilEntered()');
    }
    return this.enteredPromise;
  }

  release(): void {
    this.releaseGate?.();
  }

  async embed(texts: string[], taskType: EmbeddingTaskType): Promise<EmbedOutcome> {
    if (this.gatePromise) {
      this.resolveEntered?.();
      await this.gatePromise;
    }
    return this.inner.embed(texts, taskType);
  }
}

describe.skipIf(!integrationTestsEnabled())('Quota limits (integration, real database)', () => {
  let app: INestApplication;
  const uri = integrationTestsEnabled() ? getTestMongoUri() : '';
  const createdTenants: string[] = [];

  beforeAll(async () => {
    process.env.INGESTION_MAX_DOCUMENTS_PER_TENANT = '1';
    process.env.INGESTION_MAX_CHUNKS_PER_TENANT = '3';

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(LLM_PROVIDER)
      .useClass(FakeLlmProvider)
      .compile();
    app = moduleRef.createNestApplication();
    await app.init();
  }, 150_000);

  afterAll(async () => {
    delete process.env.INGESTION_MAX_DOCUMENTS_PER_TENANT;
    delete process.env.INGESTION_MAX_CHUNKS_PER_TENANT;
    await Promise.all(createdTenants.map((tenantId) => cleanupTenant(uri, tenantId)));
    await app.close();
    await disconnectFixtureConnection();
  });

  it('rejects a second document with 422 DOCUMENT_QUOTA_EXCEEDED once the per-tenant document cap (1) is reached', async () => {
    const tenant = await createTenantFixture(uri);
    createdTenants.push(tenant.tenantId);

    const first = await request(app.getHttpServer())
      .post('/v1/policies')
      .set('Authorization', `Bearer ${tenant.secretKey}`)
      .attach('file', Buffer.from('# First\n\nFirst document body.'), 'first.md');
    expect(first.status).toBe(201);

    const second = await request(app.getHttpServer())
      .post('/v1/policies')
      .set('Authorization', `Bearer ${tenant.secretKey}`)
      .attach('file', Buffer.from('# Second\n\nA completely different second document body.'), 'second.md');
    expect(second.status).toBe(422);
    expect(second.body.code).toBe('DOCUMENT_QUOTA_EXCEEDED');
  });

  it('rejects a document whose chunks would exceed the per-tenant chunk cap (3) with 422 CHUNK_QUOTA_EXCEEDED', async () => {
    const tenant = await createTenantFixture(uri);
    createdTenants.push(tenant.tenantId);

    // Four headings -> four chunks -> exceeds the chunk cap of 3 on the
    // very first (and, per the document cap above being separate per
    // tenant, only) upload. Each section's body must be well over ~400
    // characters (the chunker's default 100-token merge floor - see
    // markdown-chunker.ts's mergeTinySections) or same-parent sections get
    // merged into one chunk and the cap is never actually exceeded - a
    // short one-line body here, like the ones this file originally used,
    // produces exactly 1 merged chunk, not 4 (confirmed by reading
    // mergeTinySections directly, not assumed).
    const longBody = (label: string): string =>
      `${label} body text with enough unique content of its own that this section stays distinct from its siblings during chunking and is never merged with them. `.repeat(
        4,
      );
    const markdown = ['One', 'Two', 'Three', 'Four'].map((label) => `# ${label}\n\n${longBody(label)}`).join('\n\n');
    const res = await request(app.getHttpServer())
      .post('/v1/policies')
      .set('Authorization', `Bearer ${tenant.secretKey}`)
      .attach('file', Buffer.from(markdown), 'four-sections.md');

    expect(res.status).toBe(422);
    expect(res.body.code).toBe('CHUNK_QUOTA_EXCEEDED');
  });
});

describe.skipIf(!integrationTestsEnabled())('Concurrency limit: one ingestion per tenant (integration, real database)', () => {
  let app: INestApplication;
  let close: () => Promise<void>;
  let gatedProvider: GatedLlmProvider;
  const uri = integrationTestsEnabled() ? getTestMongoUri() : '';
  const createdTenants: string[] = [];

  beforeAll(async () => {
    gatedProvider = new GatedLlmProvider();
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(LLM_PROVIDER)
      .useValue(gatedProvider)
      .compile();
    app = moduleRef.createNestApplication();
    await app.init();
    close = () => app.close();
  }, 150_000);

  afterAll(async () => {
    await Promise.all(createdTenants.map((tenantId) => cleanupTenant(uri, tenantId)));
    await close();
    await disconnectFixtureConnection();
  });

  it('returns 429 TENANT_BUSY for a second concurrent upload while the first is still embedding', async () => {
    const tenant = await createTenantFixture(uri);
    createdTenants.push(tenant.tenantId);

    gatedProvider.hold();

    const firstRequest = request(app.getHttpServer())
      .post('/v1/policies')
      .set('Authorization', `Bearer ${tenant.secretKey}`)
      .attach('file', Buffer.from('# Held\n\nThis upload is held open by the gate.'), 'held.md');

    try {
      // Wait for the provider's own explicit signal that embed() was
      // actually entered - tryAcquire() happens synchronously before any
      // await in ingest(), so the lock is guaranteed held by the time
      // embed() runs, and this promise only resolves once that's true.
      // Not a timing guess (a previous version used a single setImmediate
      // tick here, which wasn't a real guarantee and hung for the full 90s
      // timeout in CI instead of failing fast).
      await gatedProvider.waitUntilEntered();

      const second = await request(app.getHttpServer())
        .post('/v1/policies')
        .set('Authorization', `Bearer ${tenant.secretKey}`)
        .attach('file', Buffer.from('# Second\n\nThis upload must be rejected as busy.'), 'second.md');

      expect(second.status).toBe(429);
      expect(second.body.code).toBe('TENANT_BUSY');
    } finally {
      // Always released, even if an assertion above failed - otherwise the
      // first request's handler stays suspended forever inside embed(),
      // which keeps an HTTP connection open and hangs this file's own
      // afterAll (app.close() waiting for in-flight connections to finish).
      gatedProvider.release();
    }

    const first = await firstRequest;
    expect(first.status).toBe(201);
  });
});
