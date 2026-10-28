import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { EMBEDDING_DIMENSION, EMBEDDING_MODEL, PolicyErrorCode } from '@supportpilot/shared';
import { LLM_PROVIDER } from '../llm/llm.module';
import { LLM_SETTINGS } from '../llm/llm-settings.provider';
import { LlmProvider } from '../llm/llm-provider.interface';
import { LlmSettings } from '../llm/llm.settings';
import { chunkMarkdown } from './chunking/markdown-chunker';
import { normalizeLineEndings, stripFrontMatter } from './chunking/normalize';
import { computeContentHash } from './content-hash';
import { INGESTION_SETTINGS } from './ingestion-settings.provider';
import { IngestionSettings } from './ingestion.settings';
import { TenantIngestionLock } from './tenant-ingestion-lock';
import { NewPolicyChunk, POLICY_CHUNK_REPOSITORY, PolicyChunkRepository } from '../db/policy-chunk.repository';
import { POLICY_DOCUMENT_REPOSITORY, PolicyDocumentRecord, PolicyDocumentRepository } from '../db/policy-document.repository';
import { TRANSACTION_RUNNER, TransactionRunner } from '../db/transaction-runner';

export interface IngestParams {
  tenantId: string;
  /** Already strictly-UTF8-decoded by the controller; the service never touches a Buffer. */
  text: string;
  title: string;
}

export type IngestOutcome =
  | { ok: true; document: PolicyDocumentRecord }
  | { ok: false; code: PolicyErrorCode; message: string; existingDocumentId?: string };

/**
 * The whole chunk -> embed -> commit pipeline for one upload, run
 * synchronously within one request (no job queue - see PROJECT.md section
 * 3's "few LLM calls" philosophy and the lack of any worker infra). Bounded
 * by `ingestionDeadlineMs`.
 */
@Injectable()
export class PolicyIngestionService {
  private readonly logger = new Logger(PolicyIngestionService.name);

  constructor(
    @Inject(INGESTION_SETTINGS) private readonly settings: IngestionSettings,
    @Inject(LLM_PROVIDER) private readonly llmProvider: LlmProvider,
    @Inject(LLM_SETTINGS) private readonly llmSettings: LlmSettings,
    private readonly tenantLock: TenantIngestionLock,
    @Optional() @Inject(POLICY_DOCUMENT_REPOSITORY) private readonly documentRepository?: PolicyDocumentRepository,
    @Optional() @Inject(POLICY_CHUNK_REPOSITORY) private readonly chunkRepository?: PolicyChunkRepository,
    @Optional() @Inject(TRANSACTION_RUNNER) private readonly transactionRunner?: TransactionRunner,
  ) {}

  async ingest(params: IngestParams): Promise<IngestOutcome> {
    if (!this.llmSettings.geminiApiKey) {
      return { ok: false, code: 'NOT_CONFIGURED', message: 'The embedding provider is not configured.' };
    }
    if (!this.documentRepository || !this.chunkRepository || !this.transactionRunner) {
      return { ok: false, code: 'NOT_CONFIGURED', message: 'The database is not configured.' };
    }

    if (!this.tenantLock.tryAcquire(params.tenantId)) {
      return { ok: false, code: 'TENANT_BUSY', message: 'Another policy document is already being ingested for this tenant.' };
    }

    try {
      return await this.runPipeline(
        params,
        this.documentRepository,
        this.chunkRepository,
        this.transactionRunner,
      );
    } finally {
      this.tenantLock.release(params.tenantId);
    }
  }

  private async runPipeline(
    params: IngestParams,
    documentRepository: PolicyDocumentRepository,
    chunkRepository: PolicyChunkRepository,
    transactionRunner: TransactionRunner,
  ): Promise<IngestOutcome> {
    const normalized = stripFrontMatter(normalizeLineEndings(params.text));
    if (normalized.trim().length === 0) {
      return { ok: false, code: 'INVALID_CONTENT', message: 'Document has no content.' };
    }
    const contentHash = computeContentHash(normalized);

    const existing = await documentRepository.findByContentHash(params.tenantId, contentHash);
    if (existing) {
      return {
        ok: false,
        code: 'DUPLICATE_CONTENT',
        message: 'This content has already been uploaded.',
        existingDocumentId: existing.id,
      };
    }

    const chunkResult = chunkMarkdown(params.text, {
      documentSlug: 'doc',
      maxChunks: this.settings.maxChunksPerDocument,
    });
    if (!chunkResult.ok) {
      if (chunkResult.error.code === 'TOO_MANY_CHUNKS') {
        return {
          ok: false,
          code: 'CHUNK_LIMIT_EXCEEDED',
          message: `This document would produce too many chunks (limit: ${this.settings.maxChunksPerDocument}). Split it into smaller documents and upload them separately.`,
        };
      }
      return { ok: false, code: 'INVALID_CONTENT', message: chunkResult.error.message };
    }
    // A heading with no body text of its own before its first subheading
    // (e.g. "## Refund Policy" immediately followed by "### Standard Refund
    // Window", nothing in between) legitimately produces an empty-text
    // chunk from the chunker - it has no same-parent sibling to merge into,
    // so it's kept as its own section rather than dropped silently inside
    // the chunker itself (confirmed against a real document, not a
    // hypothetical). Nothing is lost by skipping it here: its heading
    // still appears in every one of its subsections' headingPath.
    const chunks = chunkResult.chunks.filter((chunk) => chunk.text.trim().length > 0);
    if (chunks.length === 0) {
      // Every section the chunker found was heading-only, with no body
      // text anywhere (e.g. a document that's only a table of contents).
      return { ok: false, code: 'INVALID_CONTENT', message: 'Document has no embeddable content after chunking.' };
    }

    const existingDocumentCount = await documentRepository.countActiveForTenant(params.tenantId);
    if (existingDocumentCount >= this.settings.maxDocumentsPerTenant) {
      return {
        ok: false,
        code: 'DOCUMENT_QUOTA_EXCEEDED',
        message: `This tenant already has the maximum of ${this.settings.maxDocumentsPerTenant} policy documents.`,
      };
    }

    const existingChunkCount = await chunkRepository.countForTenant(params.tenantId);
    if (existingChunkCount + chunks.length > this.settings.maxChunksPerTenant) {
      return {
        ok: false,
        code: 'CHUNK_QUOTA_EXCEEDED',
        message: `This document's ${chunks.length} chunks would exceed the tenant's limit of ${this.settings.maxChunksPerTenant} total chunks (currently at ${existingChunkCount}).`,
      };
    }

    const document = await documentRepository.create(params.tenantId, params.title, contentHash);

    const deadlineAt = Date.now() + this.settings.ingestionDeadlineMs;
    const embeddings: number[][] = [];
    for (let i = 0; i < chunks.length; i += this.settings.embeddingBatchSize) {
      if (Date.now() >= deadlineAt) {
        await documentRepository.markFailed(params.tenantId, document.id, 'INGESTION_TIMEOUT');
        return { ok: false, code: 'INGESTION_TIMEOUT', message: 'Ingestion took too long and was aborted.' };
      }

      const batch = chunks.slice(i, i + this.settings.embeddingBatchSize);
      const embedResult = await this.llmProvider.embed(batch.map((c) => c.embeddingText), 'RETRIEVAL_DOCUMENT');
      if (!embedResult.ok) {
        await documentRepository.markFailed(params.tenantId, document.id, 'EMBEDDING_FAILED');
        return { ok: false, code: 'EMBEDDING_FAILED', message: 'Failed to embed this document.' };
      }
      for (const vector of embedResult.result.vectors) {
        embeddings.push(vector.values);
      }
    }

    try {
      await transactionRunner.withTransaction(async (session) => {
        const newChunks: NewPolicyChunk[] = chunks.map((chunk, index) => ({
          tenantId: params.tenantId,
          documentId: document.id,
          title: params.title,
          headingPath: chunk.headingPath,
          position: chunk.position,
          text: chunk.text,
          embedding: embeddings[index],
          embeddingModel: EMBEDDING_MODEL,
          embeddingDimension: EMBEDDING_DIMENSION,
          // Of embeddingText (what was actually embedded), not the display-only `text` - see policy-chunk.schema.ts.
          contentHash: computeContentHash(chunk.embeddingText),
        }));
        await chunkRepository.insertMany(newChunks, session);
        await documentRepository.markReady(params.tenantId, document.id, chunks.length, session);
      });
    } catch (err) {
      // Real MongoDB transactions already roll back atomically on any
      // error inside the callback (confirmed empirically - see
      // docs/learning-notes.md) - this delete is a safety net that's a
      // harmless no-op in that case, but is what actually guarantees "zero
      // chunks on failure" against the in-memory fakes used in tests, which
      // have no real transactional rollback of their own.
      //
      // The error itself is an infrastructure/driver error (a Mongoose
      // validation message, a transaction abort reason, etc.), never
      // document content - safe to log. Without this, a commit failure was
      // previously undiagnosable from server logs alone.
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(
        JSON.stringify({ event: 'policy_commit_failed', tenantId: params.tenantId, documentId: document.id, error: message }),
      );
      await chunkRepository.deleteForDocument(params.tenantId, document.id);
      await documentRepository.markFailed(params.tenantId, document.id, 'COMMIT_FAILED');
      return { ok: false, code: 'COMMIT_FAILED', message: 'Failed to save this document.' };
    }

    const readyDocument = await documentRepository.findById(params.tenantId, document.id);
    return { ok: true, document: readyDocument! };
  }
}
