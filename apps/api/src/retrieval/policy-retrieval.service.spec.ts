import { afterEach, describe, expect, it, vi } from 'vitest';
import { Logger } from '@nestjs/common';
import { EMBEDDING_DIMENSION, EMBEDDING_MODEL } from '@supportpilot/shared';
import { PolicyRetrievalService } from './policy-retrieval.service';
import { RetrievalSettings } from './retrieval.settings';
import { NewPolicyChunk, PolicyChunkRepository, VectorSearchParams, VectorSearchResultItem } from '../db/policy-chunk.repository';
import { InMemoryPolicyChunkRepository } from '../db/test-utils/in-memory-policy-chunk.repository';
import { FakeLlmProvider } from '../llm/test-utils/fake-llm-provider';
import { EmbedOutcome, EmbeddingTaskType, LlmProvider } from '../llm/llm-provider.interface';
import { LlmSettings } from '../llm/llm.settings';

function settings(overrides: Partial<RetrievalSettings> = {}): RetrievalSettings {
  return { maxQueryLength: 2000, defaultTopK: 5, maxTopK: 10, ...overrides };
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

function chunkFixture(overrides: Partial<NewPolicyChunk> = {}): NewPolicyChunk {
  return {
    tenantId: 'acme',
    documentId: 'doc-1',
    title: 'Refund Policy',
    headingPath: 'Refund Policy',
    position: 0,
    text: 'Refunds are issued within 30 days of purchase.',
    embedding: [1, 0, 0],
    embeddingModel: EMBEDDING_MODEL,
    embeddingDimension: EMBEDDING_DIMENSION,
    contentHash: 'h1',
    ...overrides,
  };
}

function makeService(opts: {
  chunkRepository?: PolicyChunkRepository;
  llmProvider?: LlmProvider;
  retrievalSettings?: Partial<RetrievalSettings>;
  llmSettingsOverrides?: Partial<LlmSettings>;
  omitRepository?: boolean;
} = {}) {
  const chunkRepository = opts.chunkRepository ?? new InMemoryPolicyChunkRepository();
  const service = new PolicyRetrievalService(
    settings(opts.retrievalSettings),
    opts.llmProvider ?? new FakeLlmProvider(),
    llmSettings(opts.llmSettingsOverrides),
    opts.omitRepository ? undefined : chunkRepository,
  );
  return { service, chunkRepository };
}

describe('PolicyRetrievalService.retrieve', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('two-tenant isolation: never returns another tenant\'s chunks, even when they are the closest match', async () => {
    const { service, chunkRepository } = makeService();
    // Tenant A's own chunk is a mediocre match.
    await chunkRepository.insertMany([
      chunkFixture({ tenantId: 'acme', documentId: 'doc-a', title: 'A doc', embedding: [0.6, 0.8, 0], text: 'Acme policy text.' }),
    ]);
    // Tenant B's chunk is an EXACT match - the closer one.
    await chunkRepository.insertMany([
      chunkFixture({ tenantId: 'widgetco', documentId: 'doc-b', title: 'B doc', embedding: [1, 0, 0], text: 'Widgetco policy text.' }),
    ]);

    const result = await service.retrieve('acme', 'refund query');

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.results).toHaveLength(1);
      expect(result.results[0].documentTitle).toBe('A doc');
    }
  });

  it('inactive chunks are never returned', async () => {
    const { service, chunkRepository } = makeService();
    await chunkRepository.insertMany([chunkFixture()]);
    await chunkRepository.deactivateForDocument('acme', 'doc-1');

    const result = await service.retrieve('acme', 'refund query');

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.results).toHaveLength(0);
    }
  });

  it('an empty corpus returns ok with no results, not an error', async () => {
    const { service } = makeService();
    const result = await service.retrieve('acme', 'anything');
    expect(result).toEqual({ ok: true, results: [] });
  });

  it('rejects a blank query', async () => {
    const { service } = makeService();
    const result = await service.retrieve('acme', '   ');
    expect(result).toMatchObject({ ok: false, error: { code: 'INVALID_QUERY' } });
  });

  it('rejects an oversized query', async () => {
    const { service } = makeService({ retrievalSettings: { maxQueryLength: 10 } });
    const result = await service.retrieve('acme', 'this query is way too long for the limit');
    expect(result).toMatchObject({ ok: false, error: { code: 'INVALID_QUERY' } });
  });

  it('rejects a non-positive-integer topK', async () => {
    const { service } = makeService();
    const result = await service.retrieve('acme', 'query', { topK: 0 });
    expect(result).toMatchObject({ ok: false, error: { code: 'INVALID_QUERY' } });
  });

  it('clamps (never rejects) a topK above the hard cap', async () => {
    const { service, chunkRepository } = makeService();
    for (let i = 0; i < 15; i++) {
      await chunkRepository.insertMany([chunkFixture({ documentId: `doc-${i}`, position: i, embedding: [1, 0, 0] })]);
    }

    const result = await service.retrieve('acme', 'query', { topK: 1000 });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.results.length).toBeLessThanOrEqual(10); // the hard cap
    }
  });

  it('returns NOT_CONFIGURED when the LLM provider has no API key', async () => {
    const { service } = makeService({ llmSettingsOverrides: { geminiApiKey: undefined } });
    const result = await service.retrieve('acme', 'query');
    expect(result).toMatchObject({ ok: false, error: { code: 'NOT_CONFIGURED' } });
  });

  it('returns NOT_CONFIGURED when the database is not wired up', async () => {
    const { service } = makeService({ omitRepository: true });
    const result = await service.retrieve('acme', 'query');
    expect(result).toMatchObject({ ok: false, error: { code: 'NOT_CONFIGURED' } });
  });

  it('maps an embedding failure to EMBEDDING_FAILED', async () => {
    const failingProvider: LlmProvider = {
      async embed(): Promise<EmbedOutcome> {
        return { ok: false, error: { code: 'TRANSIENT', message: 'boom' } };
      },
    };
    const { service } = makeService({ llmProvider: failingProvider });
    const result = await service.retrieve('acme', 'query');
    expect(result).toMatchObject({ ok: false, error: { code: 'EMBEDDING_FAILED' } });
  });

  it('maps a search failure (e.g. index not queryable) to SEARCH_UNAVAILABLE', async () => {
    const throwingRepository: PolicyChunkRepository = {
      ...new InMemoryPolicyChunkRepository(),
      vectorSearch: vi.fn(async () => {
        throw new Error('Index is not queryable yet');
      }),
    } as unknown as PolicyChunkRepository;
    const { service } = makeService({ chunkRepository: throwingRepository });

    const result = await service.retrieve('acme', 'query');
    expect(result).toMatchObject({ ok: false, error: { code: 'SEARCH_UNAVAILABLE' } });
  });

  it('orders results by descending score', async () => {
    // A fixed query vector, not FakeLlmProvider's real hash of the query
    // text - that hash has no predictable relationship to these
    // hand-crafted chunk embeddings, so comparing against it would be
    // asserting on an arbitrary, unrelated direction.
    const fixedVectorProvider: LlmProvider = {
      async embed(texts: string[]) {
        return { ok: true, result: { vectors: texts.map((text) => ({ text, values: [1, 0, 0] })), model: 'fixed', dimension: 3 } };
      },
    };
    const { service, chunkRepository } = makeService({ llmProvider: fixedVectorProvider });
    await chunkRepository.insertMany([
      chunkFixture({ documentId: 'doc-far', title: 'far', embedding: [0, 1, 0] }),
      chunkFixture({ documentId: 'doc-near', title: 'near', embedding: [1, 0, 0] }),
    ]);

    const result = await service.retrieve('acme', 'query');

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.results[0].documentTitle).toBe('near');
      expect(result.results[1].documentTitle).toBe('far');
      expect(result.results[0].score).toBeGreaterThanOrEqual(result.results[1].score);
    }
  });

  it('embeds the query with taskType RETRIEVAL_QUERY', async () => {
    const embed = vi.fn(async (texts: string[], taskType: EmbeddingTaskType) => {
      expect(taskType).toBe('RETRIEVAL_QUERY');
      return new FakeLlmProvider().embed(texts, taskType);
    });
    const { service } = makeService({ llmProvider: { embed } });

    await service.retrieve('acme', 'what is the refund window');

    expect(embed).toHaveBeenCalledWith(['what is the refund window'], 'RETRIEVAL_QUERY');
  });

  describe('result fields', () => {
    it('never includes the embedding vector, and chunkKey is documentId-position', async () => {
      const { service, chunkRepository } = makeService();
      await chunkRepository.insertMany([chunkFixture({ documentId: 'doc-xyz', position: 3 })]);

      const result = await service.retrieve('acme', 'query');

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(JSON.stringify(result.results)).not.toContain('"embedding"');
        expect(result.results[0].chunkKey).toBe('doc-xyz-3');
        expect(result.results[0].documentId).toBe('doc-xyz');
        expect(result.results[0].position).toBe(3);
      }
    });
  });

  describe('defense in depth', () => {
    it('drops a result that does not belong to the requested tenant and logs it, without the error leaking chunk content', async () => {
      const errorSpy = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
      const misbehavingRepository: PolicyChunkRepository = {
        ...new InMemoryPolicyChunkRepository(),
        vectorSearch: vi.fn(
          async (_params: VectorSearchParams): Promise<VectorSearchResultItem[]> => [
            {
              chunkId: 'c1',
              tenantId: 'widgetco', // WRONG tenant - the pre-filter supposedly failed
              documentId: 'doc-b',
              title: 'Leaked secret document title',
              headingPath: '',
              text: 'leaked secret chunk text',
              position: 0,
              embeddingModel: EMBEDDING_MODEL,
              embeddingDimension: EMBEDDING_DIMENSION,
              score: 0.99,
            },
          ],
        ),
      } as unknown as PolicyChunkRepository;
      const { service } = makeService({ chunkRepository: misbehavingRepository });

      const result = await service.retrieve('acme', 'query');

      expect(result).toEqual({ ok: true, results: [] });
      expect(errorSpy).toHaveBeenCalled();
      const loggedText = errorSpy.mock.calls.map((c) => String(c[0])).join('\n');
      expect(loggedText).toContain('DEFENSE_IN_DEPTH_CROSS_TENANT_RESULT');
      expect(loggedText).not.toContain('leaked secret chunk text');
      expect(loggedText).not.toContain('Leaked secret document title');
    });

    it('skips a result embedded with a different model or dimension than the current configuration, and logs a count', async () => {
      const warnSpy = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      const { service, chunkRepository } = makeService();
      await chunkRepository.insertMany([
        chunkFixture({ documentId: 'doc-stale', embeddingModel: 'old-model', embeddingDimension: 256 }),
        chunkFixture({ documentId: 'doc-current' }),
      ]);

      const result = await service.retrieve('acme', 'query');

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.results).toHaveLength(1);
        expect(result.results[0].documentId).toBe('doc-current');
      }
      const loggedText = warnSpy.mock.calls.map((c) => String(c[0])).join('\n');
      expect(loggedText).toContain('STALE_EMBEDDING_CONFIG_SKIPPED');
    });
  });

  describe('privacy: logs never contain the query text or chunk text', () => {
    it('logs only tenantId, query length, result count, top score, and duration', async () => {
      const logSpy = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
      const { service, chunkRepository } = makeService();
      await chunkRepository.insertMany([chunkFixture({ text: 'This exact sentence must never appear in a log line.' })]);

      const secretQuery = 'a very specific customer query that must never be logged verbatim';
      await service.retrieve('acme', secretQuery);

      const loggedText = logSpy.mock.calls.map((c) => String(c[0])).join('\n');
      expect(loggedText).toContain('acme');
      expect(loggedText).toContain('policy_retrieve');
      expect(loggedText).not.toContain(secretQuery);
      expect(loggedText).not.toContain('This exact sentence must never appear in a log line.');
    });
  });
});
