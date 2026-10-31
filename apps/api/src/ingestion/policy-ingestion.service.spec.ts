import { describe, expect, it, vi } from 'vitest';
import { IngestionSettings } from './ingestion.settings';
import { PolicyIngestionService } from './policy-ingestion.service';
import { TenantIngestionLock } from './tenant-ingestion-lock';
import { InMemoryPolicyChunkRepository } from '../db/test-utils/in-memory-policy-chunk.repository';
import { InMemoryPolicyDocumentRepository } from '../db/test-utils/in-memory-policy-document.repository';
import { TransactionRunner } from '../db/transaction-runner';
import { FakeLlmProvider } from '../llm/test-utils/fake-llm-provider';
import { LlmProvider, EmbedOutcome, EmbeddingTaskType } from '../llm/llm-provider.interface';
import { LlmSettings } from '../llm/llm.settings';

function settings(overrides: Partial<IngestionSettings> = {}): IngestionSettings {
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
    generateModel: 'gemini-3.5-flash-lite',
    generateRequestsPerMinute: 1000,
    generateMaxConcurrency: 1000,
    generateMaxRetries: 0,
    generateTimeoutMs: 5000,
    generateMaxOutputTokens: 1024,
    generateTemperature: 0,
    ...overrides,
  };
}

class FailingLlmProvider implements LlmProvider {
  constructor(private readonly failOnCall: number) {}
  private calls = 0;
  async embed(texts: string[], _taskType: EmbeddingTaskType): Promise<EmbedOutcome> {
    this.calls += 1;
    if (this.calls >= this.failOnCall) {
      return { ok: false, error: { code: 'TRANSIENT', message: 'simulated failure' } };
    }
    const fake = new FakeLlmProvider();
    return fake.embed(texts, _taskType);
  }
}

function makeService(opts: {
  ingestionSettings?: Partial<IngestionSettings>;
  llmProvider?: LlmProvider;
  llmSettings?: Partial<LlmSettings>;
  documentRepository?: InMemoryPolicyDocumentRepository;
  chunkRepository?: InMemoryPolicyChunkRepository;
  transactionRunner?: TransactionRunner;
  omitRepositories?: boolean;
} = {}) {
  const documentRepository = opts.documentRepository ?? new InMemoryPolicyDocumentRepository();
  const chunkRepository = opts.chunkRepository ?? new InMemoryPolicyChunkRepository();
  const transactionRunner: TransactionRunner = opts.transactionRunner ?? {
    withTransaction: async (fn) => fn(undefined as never),
  };

  const service = new PolicyIngestionService(
    settings(opts.ingestionSettings),
    opts.llmProvider ?? new FakeLlmProvider(),
    llmSettings(opts.llmSettings),
    new TenantIngestionLock(),
    opts.omitRepositories ? undefined : documentRepository,
    opts.omitRepositories ? undefined : chunkRepository,
    opts.omitRepositories ? undefined : transactionRunner,
  );

  return { service, documentRepository, chunkRepository, transactionRunner };
}

const SAMPLE_MARKDOWN = '# Refund Policy\n\nRefunds are issued within 30 days of purchase, no exceptions apply here at all.';

describe('PolicyIngestionService.ingest', () => {
  it('happy path: creates a ready document with the right chunk count', async () => {
    const { service, documentRepository } = makeService();
    const result = await service.ingest({ tenantId: 'acme', text: SAMPLE_MARKDOWN, title: 'Refund Policy' });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.document.status).toBe('ready');
      expect(result.document.chunkCount).toBeGreaterThan(0);
    }
    const stored = await documentRepository.findAllForTenant('acme');
    expect(stored).toHaveLength(1);
    expect(stored[0].status).toBe('ready');
  });

  it('returns NOT_CONFIGURED when the LLM provider has no API key, without creating any document', async () => {
    const { service, documentRepository } = makeService({ llmSettings: { geminiApiKey: undefined } });
    const result = await service.ingest({ tenantId: 'acme', text: SAMPLE_MARKDOWN, title: 'x' });

    expect(result).toMatchObject({ ok: false, code: 'NOT_CONFIGURED' });
    expect(await documentRepository.findAllForTenant('acme')).toHaveLength(0);
  });

  it('returns NOT_CONFIGURED when the database repositories are not wired up', async () => {
    const { service } = makeService({ omitRepositories: true });
    const result = await service.ingest({ tenantId: 'acme', text: SAMPLE_MARKDOWN, title: 'x' });
    expect(result).toMatchObject({ ok: false, code: 'NOT_CONFIGURED' });
  });

  it('rejects empty/whitespace-only content as INVALID_CONTENT, without creating a document', async () => {
    const { service, documentRepository } = makeService();
    const result = await service.ingest({ tenantId: 'acme', text: '   \n\n  ', title: 'x' });

    expect(result).toMatchObject({ ok: false, code: 'INVALID_CONTENT' });
    expect(await documentRepository.findAllForTenant('acme')).toHaveLength(0);
  });

  it('a document-level chunk cap exceeded returns CHUNK_LIMIT_EXCEEDED with a clear message, and creates no document', async () => {
    // Each section's body is padded well past the chunker's default
    // minMergeTokens (100 tokens / ~400 chars) so they stay as distinct
    // sections instead of cascading together into one merged chunk.
    const manyHeadings = Array.from(
      { length: 10 },
      (_, i) => `# Heading ${i}\n\n${'Some unique filler content for this section. '.repeat(15)}(section ${i})`,
    ).join('\n\n');
    const { service, documentRepository } = makeService({ ingestionSettings: { maxChunksPerDocument: 3 } });
    const result = await service.ingest({ tenantId: 'acme', text: manyHeadings, title: 'x' });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('CHUNK_LIMIT_EXCEEDED');
      expect(result.message).toMatch(/too many chunks/i);
      expect(result.message).toContain('3');
    }
    expect(await documentRepository.findAllForTenant('acme')).toHaveLength(0);
  });

  it('duplicate content for the same tenant returns 409-style DUPLICATE_CONTENT with the existing document id', async () => {
    const { service } = makeService();
    const first = await service.ingest({ tenantId: 'acme', text: SAMPLE_MARKDOWN, title: 'Refund Policy' });
    expect(first.ok).toBe(true);

    const second = await service.ingest({ tenantId: 'acme', text: SAMPLE_MARKDOWN, title: 'Refund Policy Again' });
    expect(second.ok).toBe(false);
    if (!second.ok && first.ok) {
      expect(second.code).toBe('DUPLICATE_CONTENT');
      expect(second.existingDocumentId).toBe(first.document.id);
    }
  });

  it('the same content for a DIFFERENT tenant is not a duplicate', async () => {
    const { service } = makeService();
    const first = await service.ingest({ tenantId: 'acme', text: SAMPLE_MARKDOWN, title: 'x' });
    const second = await service.ingest({ tenantId: 'widgetco', text: SAMPLE_MARKDOWN, title: 'x' });
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
  });

  it('document quota exceeded returns DOCUMENT_QUOTA_EXCEEDED before creating a new document', async () => {
    const { service, documentRepository } = makeService({ ingestionSettings: { maxDocumentsPerTenant: 1 } });
    await documentRepository.create('acme', 'Existing', 'existing-hash');

    const result = await service.ingest({ tenantId: 'acme', text: SAMPLE_MARKDOWN, title: 'x' });
    expect(result).toMatchObject({ ok: false, code: 'DOCUMENT_QUOTA_EXCEEDED' });
    expect(await documentRepository.findAllForTenant('acme')).toHaveLength(1); // only the pre-existing one
  });

  it('chunk quota exceeded returns CHUNK_QUOTA_EXCEEDED before creating a new document', async () => {
    const { service, documentRepository, chunkRepository } = makeService({ ingestionSettings: { maxChunksPerTenant: 1 } });
    await chunkRepository.insertMany([
      {
        tenantId: 'acme',
        documentId: 'existing-doc',
        title: 'x',
        headingPath: '',
        position: 0,
        text: 'x',
        embedding: [1],
        embeddingModel: 'fake',
        embeddingDimension: 1,
        contentHash: 'h',
      },
    ]);

    const result = await service.ingest({ tenantId: 'acme', text: SAMPLE_MARKDOWN, title: 'x' });
    expect(result).toMatchObject({ ok: false, code: 'CHUNK_QUOTA_EXCEEDED' });
    expect(await documentRepository.findAllForTenant('acme')).toHaveLength(0);
  });

  it('embedding failing midway marks the document failed with zero chunks', async () => {
    const { service, documentRepository, chunkRepository } = makeService({
      llmProvider: new FailingLlmProvider(1),
      ingestionSettings: { embeddingBatchSize: 1 },
    });

    const manyHeadings = Array.from({ length: 5 }, (_, i) => `# Heading ${i}\n\nSome unique content for section ${i} here.`).join('\n\n');
    const result = await service.ingest({ tenantId: 'acme', text: manyHeadings, title: 'x' });

    expect(result).toMatchObject({ ok: false, code: 'EMBEDDING_FAILED' });
    const stored = await documentRepository.findAllForTenant('acme');
    expect(stored).toHaveLength(1);
    expect(stored[0].status).toBe('failed');
    expect(stored[0].failureCode).toBe('EMBEDDING_FAILED');
    expect(await chunkRepository.countForTenant('acme')).toBe(0);
  });

  it('a failure inside the commit step leaves zero chunks and a failed document', async () => {
    const documentRepository = new InMemoryPolicyDocumentRepository();
    documentRepository.markReady = vi.fn(async () => {
      throw new Error('simulated commit failure');
    });
    const { service, chunkRepository } = makeService({ documentRepository });

    const result = await service.ingest({ tenantId: 'acme', text: SAMPLE_MARKDOWN, title: 'x' });

    expect(result).toMatchObject({ ok: false, code: 'COMMIT_FAILED' });
    const stored = await documentRepository.findAllForTenant('acme');
    expect(stored).toHaveLength(1);
    expect(stored[0].status).toBe('failed');
    expect(stored[0].failureCode).toBe('COMMIT_FAILED');
    expect(await chunkRepository.countForTenant('acme')).toBe(0);
  });

  it('the overall ingestion deadline aborts and marks the document failed', async () => {
    const { service, documentRepository } = makeService({ ingestionSettings: { ingestionDeadlineMs: 0, embeddingBatchSize: 1 } });
    const manyHeadings = Array.from({ length: 5 }, (_, i) => `# Heading ${i}\n\nSome unique content for section ${i} here.`).join('\n\n');

    const result = await service.ingest({ tenantId: 'acme', text: manyHeadings, title: 'x' });

    expect(result).toMatchObject({ ok: false, code: 'INGESTION_TIMEOUT' });
    const stored = await documentRepository.findAllForTenant('acme');
    expect(stored[0].failureCode).toBe('INGESTION_TIMEOUT');
  });

  it('TENANT_BUSY: a second concurrent ingestion for the same tenant is rejected while the first is in flight', async () => {
    const { service } = makeService();
    const firstPromise = service.ingest({ tenantId: 'acme', text: SAMPLE_MARKDOWN, title: 'x' });
    const second = await service.ingest({ tenantId: 'acme', text: 'different content entirely, not a duplicate at all here', title: 'y' });

    expect(second).toMatchObject({ ok: false, code: 'TENANT_BUSY' });
    await firstPromise;
  });

  it('embeds with taskType RETRIEVAL_DOCUMENT and the embeddingText (heading + body), not the bare display text', async () => {
    const embed = vi.fn(async (texts: string[], taskType: EmbeddingTaskType) => {
      const fake = new FakeLlmProvider();
      expect(taskType).toBe('RETRIEVAL_DOCUMENT');
      return fake.embed(texts, taskType);
    });
    const { service } = makeService({ llmProvider: { embed } });

    await service.ingest({ tenantId: 'acme', text: SAMPLE_MARKDOWN, title: 'Refund Policy' });

    expect(embed).toHaveBeenCalled();
    const [texts] = embed.mock.calls[0];
    expect(texts[0]).toContain('Refund Policy'); // the heading path, prepended to the embedded string
  });

  it('a heading with no body of its own before its first subheading never produces an empty-text chunk (found against a real document)', async () => {
    // "## Refund Policy" has no body text before "### Standard Refund
    // Window" - the chunker keeps that as its own empty section (no
    // same-parent sibling to merge into), which would otherwise fail
    // PolicyChunk's schema-level `text` required check at commit time.
    const text =
      '# Company Policy\n\nIntro paragraph with enough content to stand on its own as a real chunk here.\n\n## Refund Policy\n\n### Standard Window\n\nRefunds are accepted within 30 days of purchase, no exceptions apply at all.';
    const { service, chunkRepository } = makeService();

    const result = await service.ingest({ tenantId: 'acme', text, title: 'Company Policy' });

    expect(result.ok).toBe(true);
    const stored = await chunkRepository.vectorSearch({ tenantId: 'acme', queryVector: [1], limit: 100, exact: true });
    expect(stored.every((c) => c.text.trim().length > 0)).toBe(true);
  });

});
