import { afterEach, describe, expect, it, vi } from 'vitest';
import { INestApplication, Logger } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { ApiKeyGuard } from '../auth/api-key.guard';
import { generateRawApiKey, getKeyPrefix, hashApiKey } from '../auth/api-key.service';
import { API_KEY_REPOSITORY } from '../db/api-key.repository';
import { InMemoryApiKeyRepository } from '../db/test-utils/in-memory-api-key.repository';
import { InMemoryPolicyChunkRepository } from '../db/test-utils/in-memory-policy-chunk.repository';
import { InMemoryPolicyDocumentRepository } from '../db/test-utils/in-memory-policy-document.repository';
import { POLICY_CHUNK_REPOSITORY } from '../db/policy-chunk.repository';
import { POLICY_DOCUMENT_REPOSITORY } from '../db/policy-document.repository';
import { TRANSACTION_RUNNER } from '../db/transaction-runner';
import { FakeLlmProvider } from '../llm/test-utils/fake-llm-provider';
import { LLM_PROVIDER } from '../llm/llm.module';
import { LLM_SETTINGS } from '../llm/llm-settings.provider';
import { LlmSettings } from '../llm/llm.settings';
import { INGESTION_SETTINGS } from './ingestion-settings.provider';
import { IngestionSettings } from './ingestion.settings';
import { MulterExceptionFilter } from './multer-exception.filter';
import { PoliciesController } from './policies.controller';
import { PolicyIngestionService } from './policy-ingestion.service';
import { TenantIngestionLock } from './tenant-ingestion-lock';

function ingestionSettings(overrides: Partial<IngestionSettings> = {}): IngestionSettings {
  return {
    maxFileBytes: 1_000_000,
    titleMaxLength: 200,
    maxChunksPerDocument: 500,
    maxDocumentsPerTenant: 50,
    maxChunksPerTenant: 2000,
    embeddingBatchSize: 16,
    ingestionDeadlineMs: 60_000,
    stalePendingMarginMs: 30_000,
    ...overrides,
  };
}

function llmSettings(overrides: Partial<LlmSettings> = {}): LlmSettings {
  return {
    geminiApiKey: 'sk_test',
    requestsPerMinute: 1000,
    maxConcurrency: 1000,
    maxRetries: 0,
    requestTimeoutMs: 5000,
    maxTextsPerBatch: 32,
    maxCharsPerText: 8000,
    cacheMaxEntries: 500,
    ...overrides,
  };
}

const SAMPLE_MARKDOWN = '# Refund Policy\n\nRefunds are issued within 30 days of purchase, no exceptions apply here at all.';

async function buildApp(overrides: {
  ingestionSettings?: Partial<IngestionSettings>;
  llmSettings?: Partial<LlmSettings>;
  llmProvider?: { embed: (texts: string[], taskType: string) => Promise<unknown> };
} = {}) {
  const apiKeyRepository = new InMemoryApiKeyRepository();
  const documentRepository = new InMemoryPolicyDocumentRepository();
  const chunkRepository = new InMemoryPolicyChunkRepository();

  const moduleRef = await Test.createTestingModule({
    controllers: [PoliciesController],
    providers: [
      ApiKeyGuard,
      Reflector,
      PolicyIngestionService,
      TenantIngestionLock,
      MulterExceptionFilter,
      { provide: API_KEY_REPOSITORY, useValue: apiKeyRepository },
      { provide: POLICY_DOCUMENT_REPOSITORY, useValue: documentRepository },
      { provide: POLICY_CHUNK_REPOSITORY, useValue: chunkRepository },
      { provide: TRANSACTION_RUNNER, useValue: { withTransaction: async (fn: (s: undefined) => Promise<unknown>) => fn(undefined) } },
      { provide: LLM_PROVIDER, useValue: overrides.llmProvider ?? new FakeLlmProvider() },
      { provide: LLM_SETTINGS, useValue: llmSettings(overrides.llmSettings) },
      { provide: INGESTION_SETTINGS, useValue: ingestionSettings(overrides.ingestionSettings) },
    ],
  }).compile();

  const app = moduleRef.createNestApplication();
  await app.init();

  async function createKey(tenantId: string, scope: 'public' | 'secret' = 'secret') {
    const rawKey = generateRawApiKey();
    const hash = hashApiKey(rawKey);
    const id = await apiKeyRepository.create(tenantId, hash, getKeyPrefix(rawKey), [scope]);
    return { rawKey, id };
  }

  return { app, apiKeyRepository, documentRepository, chunkRepository, createKey };
}

describe('PoliciesController', () => {
  let app: INestApplication | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  describe('POST /v1/policies', () => {
    it('happy path: uploads a .md file and returns the ready document summary', async () => {
      const built = await buildApp();
      app = built.app;
      const { rawKey } = await built.createKey('acme');

      const res = await request(app.getHttpServer())
        .post('/v1/policies')
        .set('Authorization', `Bearer ${rawKey}`)
        .field('title', 'Refund Policy')
        .attach('file', Buffer.from(SAMPLE_MARKDOWN), 'policy.md');

      expect(res.status).toBe(201);
      expect(res.body.status).toBe('ready');
      expect(res.body.title).toBe('Refund Policy');
      expect(res.body.chunkCount).toBeGreaterThan(0);
      expect(res.body.failureCode).toBeNull();
      expect(JSON.stringify(res.body)).not.toContain('embedding');
      expect(JSON.stringify(res.body)).not.toContain('Refunds are issued within 30 days'); // no raw text in the response
    });

    it('rejects a disallowed extension', async () => {
      const built = await buildApp();
      app = built.app;
      const { rawKey } = await built.createKey('acme');

      const res = await request(app.getHttpServer())
        .post('/v1/policies')
        .set('Authorization', `Bearer ${rawKey}`)
        .attach('file', Buffer.from(SAMPLE_MARKDOWN), 'policy.pdf');

      expect(res.status).toBe(422);
      expect(res.body.code).toBe('INVALID_FILE_TYPE');
    });

    it('rejects an oversize file at the multer stream level', async () => {
      const built = await buildApp({ ingestionSettings: { maxFileBytes: 1000 } });
      app = built.app;
      const { rawKey } = await built.createKey('acme');

      const res = await request(app.getHttpServer())
        .post('/v1/policies')
        .set('Authorization', `Bearer ${rawKey}`)
        .attach('file', Buffer.alloc(2_000_000, 'a'), 'policy.md'); // bigger than the hardcoded 1MB multer limit

      expect(res.status).toBe(413);
      expect(res.body.code).toBe('FILE_TOO_LARGE');
    });

    it('rejects invalid UTF-8', async () => {
      const built = await buildApp();
      app = built.app;
      const { rawKey } = await built.createKey('acme');

      const res = await request(app.getHttpServer())
        .post('/v1/policies')
        .set('Authorization', `Bearer ${rawKey}`)
        .attach('file', Buffer.from([0xff, 0xfe, 0x00, 0x41]), 'policy.md');

      expect(res.status).toBe(422);
      expect(res.body.code).toBe('INVALID_ENCODING');
    });

    it('rejects a NUL byte in the content', async () => {
      const built = await buildApp();
      app = built.app;
      const { rawKey } = await built.createKey('acme');

      const res = await request(app.getHttpServer())
        .post('/v1/policies')
        .set('Authorization', `Bearer ${rawKey}`)
        .attach('file', Buffer.from('before\u0000after', 'utf8'), 'policy.md');

      expect(res.status).toBe(422);
      expect(res.body.code).toBe('INVALID_CONTENT');
    });

    it('rejects an empty file', async () => {
      const built = await buildApp();
      app = built.app;
      const { rawKey } = await built.createKey('acme');

      const res = await request(app.getHttpServer())
        .post('/v1/policies')
        .set('Authorization', `Bearer ${rawKey}`)
        .attach('file', Buffer.from(''), 'policy.md');

      expect(res.status).toBe(422);
      expect(res.body.code).toBe('INVALID_CONTENT');
    });

    it('returns 503 NOT_CONFIGURED when the LLM provider has no API key', async () => {
      const built = await buildApp({ llmSettings: { geminiApiKey: undefined } });
      app = built.app;
      const { rawKey } = await built.createKey('acme');

      const res = await request(app.getHttpServer())
        .post('/v1/policies')
        .set('Authorization', `Bearer ${rawKey}`)
        .attach('file', Buffer.from(SAMPLE_MARKDOWN), 'policy.md');

      expect(res.status).toBe(503);
      expect(res.body.code).toBe('NOT_CONFIGURED');
    });

    it('duplicate content for the same tenant returns 409 with the existing document id', async () => {
      const built = await buildApp();
      app = built.app;
      const { rawKey } = await built.createKey('acme');

      const first = await request(app.getHttpServer())
        .post('/v1/policies')
        .set('Authorization', `Bearer ${rawKey}`)
        .attach('file', Buffer.from(SAMPLE_MARKDOWN), 'policy.md');
      const second = await request(app.getHttpServer())
        .post('/v1/policies')
        .set('Authorization', `Bearer ${rawKey}`)
        .attach('file', Buffer.from(SAMPLE_MARKDOWN), 'policy-again.md');

      expect(second.status).toBe(409);
      expect(second.body.code).toBe('DUPLICATE_CONTENT');
      expect(second.body.existingDocumentId).toBe(first.body.id);
    });

    it('a busy tenant (concurrent upload) gets 429', async () => {
      // Deterministic instead of racing two real concurrent requests: the
      // tenant lock is acquired at the very start of ingest(), before
      // chunking or embedding - gating embed() on a promise WE control
      // proves the lock is held for the whole pipeline duration, without
      // depending on how fast two in-process HTTP requests happen to
      // interleave (policy-ingestion.service.spec.ts's equivalent test
      // avoids this race entirely by not going through HTTP/multipart).
      let signalEmbedStarted: () => void;
      let releaseFirst: () => void;
      const embedStarted = new Promise<void>((resolve) => {
        signalEmbedStarted = resolve;
      });
      const gate = new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      const fake = new FakeLlmProvider();
      const gatedProvider = {
        embed: async (texts: string[], taskType: string) => {
          signalEmbedStarted();
          await gate;
          return fake.embed(texts, taskType as never);
        },
      };

      const built = await buildApp({ llmProvider: gatedProvider });
      app = built.app;
      const { rawKey } = await built.createKey('acme');

      // supertest/superagent requests don't actually hit the wire until
      // something calls .then()/.end() on them - chaining .then() here
      // (without awaiting it) starts the request immediately instead of
      // only once `firstPromise` is finally awaited at the bottom, which
      // would otherwise deadlock this test against `embedStarted` below.
      const firstPromise = request(app.getHttpServer())
        .post('/v1/policies')
        .set('Authorization', `Bearer ${rawKey}`)
        .attach('file', Buffer.from(SAMPLE_MARKDOWN), 'policy.md')
        .then((res) => res);

      await embedStarted; // the lock is now definitely held

      const second = await request(app.getHttpServer())
        .post('/v1/policies')
        .set('Authorization', `Bearer ${rawKey}`)
        .attach('file', Buffer.from('different content entirely, not a duplicate at all'), 'policy2.md');

      expect(second.status).toBe(429);
      expect(second.body.code).toBe('TENANT_BUSY');

      releaseFirst();
      await firstPromise;
    });

    it('a tenant document quota exceeded returns 422', async () => {
      const built = await buildApp({ ingestionSettings: { maxDocumentsPerTenant: 0 } });
      app = built.app;
      const { rawKey } = await built.createKey('acme');

      const res = await request(app.getHttpServer())
        .post('/v1/policies')
        .set('Authorization', `Bearer ${rawKey}`)
        .attach('file', Buffer.from(SAMPLE_MARKDOWN), 'policy.md');

      expect(res.status).toBe(422);
      expect(res.body.code).toBe('DOCUMENT_QUOTA_EXCEEDED');
    });

    it('ignores a body-supplied tenantId entirely - tenant comes only from the API key', async () => {
      const built = await buildApp();
      app = built.app;
      const { rawKey } = await built.createKey('acme');

      const res = await request(app.getHttpServer())
        .post('/v1/policies')
        .set('Authorization', `Bearer ${rawKey}`)
        .field('tenantId', 'widgetco') // the only field sent - stays within the 1-field multer limit
        .attach('file', Buffer.from(SAMPLE_MARKDOWN), 'policy.md');

      expect(res.status).toBe(201);
      const stored = await built.documentRepository.findAllForTenant('acme');
      const otherTenantStored = await built.documentRepository.findAllForTenant('widgetco');
      expect(stored).toHaveLength(1);
      expect(otherTenantStored).toHaveLength(0);
    });

    describe('every auth failure mode returns the identical generic 401', () => {
      it('missing Authorization header', async () => {
        const built = await buildApp();
        app = built.app;
        const res = await request(app.getHttpServer()).post('/v1/policies').attach('file', Buffer.from(SAMPLE_MARKDOWN), 'policy.md');
        expect(res.status).toBe(401);
        expect(res.body).toMatchObject({ statusCode: 401, message: 'Unauthorized' });
      });

      it('revoked key', async () => {
        const built = await buildApp();
        app = built.app;
        const { rawKey, id } = await built.createKey('acme');
        await built.apiKeyRepository.revoke(id);

        const res = await request(app.getHttpServer())
          .post('/v1/policies')
          .set('Authorization', `Bearer ${rawKey}`)
          .attach('file', Buffer.from(SAMPLE_MARKDOWN), 'policy.md');
        expect(res.status).toBe(401);
        expect(res.body).toMatchObject({ statusCode: 401, message: 'Unauthorized' });
      });

      it('wrong scope (public key on a secret-scoped route)', async () => {
        const built = await buildApp();
        app = built.app;
        const { rawKey } = await built.createKey('acme', 'public');

        const res = await request(app.getHttpServer())
          .post('/v1/policies')
          .set('Authorization', `Bearer ${rawKey}`)
          .attach('file', Buffer.from(SAMPLE_MARKDOWN), 'policy.md');
        expect(res.status).toBe(401);
        expect(res.body).toMatchObject({ statusCode: 401, message: 'Unauthorized' });
      });
    });

    it('logs tenantId/documentId/counts/duration/outcome but never the document content', async () => {
      const logSpy = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
      const built = await buildApp();
      app = built.app;
      const { rawKey } = await built.createKey('acme');

      const res = await request(app.getHttpServer())
        .post('/v1/policies')
        .set('Authorization', `Bearer ${rawKey}`)
        .attach('file', Buffer.from(SAMPLE_MARKDOWN), 'policy.md');

      const loggedText = logSpy.mock.calls.map((call) => String(call[0])).join('\n');
      logSpy.mockRestore();

      expect(res.status).toBe(201);
      expect(loggedText).toContain('acme');
      expect(loggedText).toContain(res.body.id);
      expect(loggedText).not.toContain('Refunds are issued within 30 days');
    });
  });

  describe('GET /v1/policies', () => {
    it('lists only the calling tenant\'s documents, never another tenant\'s', async () => {
      const built = await buildApp();
      app = built.app;
      const { rawKey: acmeKey } = await built.createKey('acme');
      await built.documentRepository.create('widgetco', 'Other tenant doc', 'hash-other');
      await built.documentRepository.create('acme', 'Acme doc', 'hash-acme');

      const res = await request(app.getHttpServer()).get('/v1/policies').set('Authorization', `Bearer ${acmeKey}`);

      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(1);
      expect(res.body[0].title).toBe('Acme doc');
    });

    it('never includes text or embeddings in the response', async () => {
      const built = await buildApp();
      app = built.app;
      const { rawKey } = await built.createKey('acme');

      await request(app.getHttpServer())
        .post('/v1/policies')
        .set('Authorization', `Bearer ${rawKey}`)
        .attach('file', Buffer.from(SAMPLE_MARKDOWN), 'policy.md');

      const res = await request(app.getHttpServer()).get('/v1/policies').set('Authorization', `Bearer ${rawKey}`);
      expect(JSON.stringify(res.body)).not.toContain('embedding');
      expect(JSON.stringify(res.body)).not.toContain('Refunds are issued within 30 days');
    });

    it('returns 503 when the database is not configured', async () => {
      const moduleRef = await Test.createTestingModule({
        controllers: [PoliciesController],
        providers: [
          ApiKeyGuard,
          Reflector,
          PolicyIngestionService,
          TenantIngestionLock,
          MulterExceptionFilter,
          { provide: API_KEY_REPOSITORY, useValue: new InMemoryApiKeyRepository() },
          { provide: LLM_PROVIDER, useValue: new FakeLlmProvider() },
          { provide: LLM_SETTINGS, useValue: llmSettings() },
          { provide: INGESTION_SETTINGS, useValue: ingestionSettings() },
          // POLICY_DOCUMENT_REPOSITORY / POLICY_CHUNK_REPOSITORY / TRANSACTION_RUNNER deliberately omitted.
        ],
      }).compile();
      app = moduleRef.createNestApplication();
      await app.init();

      const apiKeyRepository = moduleRef.get(API_KEY_REPOSITORY);
      const rawKey = generateRawApiKey();
      await apiKeyRepository.create('acme', hashApiKey(rawKey), getKeyPrefix(rawKey), ['secret']);

      const res = await request(app.getHttpServer()).get('/v1/policies').set('Authorization', `Bearer ${rawKey}`);
      expect(res.status).toBe(503);
      expect(res.body.code).toBe('NOT_CONFIGURED');
    });
  });

  describe('DELETE /v1/policies/:id', () => {
    it('deletes a document and its chunks', async () => {
      const built = await buildApp();
      app = built.app;
      const { rawKey } = await built.createKey('acme');

      const created = await request(app.getHttpServer())
        .post('/v1/policies')
        .set('Authorization', `Bearer ${rawKey}`)
        .attach('file', Buffer.from(SAMPLE_MARKDOWN), 'policy.md');

      const res = await request(app.getHttpServer()).delete(`/v1/policies/${created.body.id}`).set('Authorization', `Bearer ${rawKey}`);
      expect(res.status).toBe(204);

      expect(await built.documentRepository.findById('acme', created.body.id)).toBeNull();
      expect(await built.chunkRepository.countForTenant('acme')).toBe(0);
    });

    it('returns 404 for a nonexistent id', async () => {
      const built = await buildApp();
      app = built.app;
      const { rawKey } = await built.createKey('acme');

      const res = await request(app.getHttpServer()).delete('/v1/policies/does-not-exist').set('Authorization', `Bearer ${rawKey}`);
      expect(res.status).toBe(404);
    });

    it("returns the identical 404 for another tenant's document id (never reveals it exists)", async () => {
      const built = await buildApp();
      app = built.app;
      const { rawKey: widgetcoKey } = await built.createKey('widgetco');
      const acmeDoc = await built.documentRepository.create('acme', 'Acme doc', 'hash-acme');

      const notFoundForOther = await request(app.getHttpServer())
        .delete(`/v1/policies/${acmeDoc.id}`)
        .set('Authorization', `Bearer ${widgetcoKey}`);
      const notFoundForMissing = await request(app.getHttpServer())
        .delete('/v1/policies/totally-made-up-id')
        .set('Authorization', `Bearer ${widgetcoKey}`);

      expect(notFoundForOther.status).toBe(404);
      expect(notFoundForMissing.status).toBe(404);
      expect(notFoundForOther.body).toEqual(notFoundForMissing.body);

      // And it was never actually touched.
      expect(await built.documentRepository.findById('acme', acmeDoc.id)).not.toBeNull();
    });

    it('a second delete of the same (now-deleted) id returns the identical 404 as a nonexistent id', async () => {
      const built = await buildApp();
      app = built.app;
      const { rawKey } = await built.createKey('acme');

      const created = await request(app.getHttpServer())
        .post('/v1/policies')
        .set('Authorization', `Bearer ${rawKey}`)
        .attach('file', Buffer.from(SAMPLE_MARKDOWN), 'policy.md');

      const first = await request(app.getHttpServer()).delete(`/v1/policies/${created.body.id}`).set('Authorization', `Bearer ${rawKey}`);
      expect(first.status).toBe(204);

      const second = await request(app.getHttpServer()).delete(`/v1/policies/${created.body.id}`).set('Authorization', `Bearer ${rawKey}`);
      const neverExisted = await request(app.getHttpServer())
        .delete('/v1/policies/totally-made-up-id')
        .set('Authorization', `Bearer ${rawKey}`);

      expect(second.status).toBe(404);
      expect(second.body).toEqual(neverExisted.body);
    });
  });
});
