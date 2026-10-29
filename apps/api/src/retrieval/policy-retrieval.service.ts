import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { EMBEDDING_DIMENSION, EMBEDDING_MODEL, RetrievalErrorCode, RetrievalResult } from '@supportpilot/shared';
import { LLM_PROVIDER } from '../llm/llm.module';
import { LLM_SETTINGS } from '../llm/llm-settings.provider';
import { LlmProvider } from '../llm/llm-provider.interface';
import { LlmSettings } from '../llm/llm.settings';
import { POLICY_CHUNK_REPOSITORY, PolicyChunkRepository, VectorSearchResultItem } from '../db/policy-chunk.repository';
import { RETRIEVAL_SETTINGS } from './retrieval-settings.provider';
import { RetrievalSettings } from './retrieval.settings';

export interface RetrieveOptions {
  topK?: number;
  /** ENN instead of ANN - see VectorSearchParams.exact. */
  exact?: boolean;
}

export type RetrieveOutcome = { ok: true; results: RetrievalResult[] } | { ok: false; error: { code: RetrievalErrorCode; message: string } };

function isPositiveInteger(value: number): boolean {
  return Number.isInteger(value) && value > 0;
}

/**
 * Retrieved text (chunk.text, documentTitle, headingPath) is UNTRUSTED
 * DATA for every caller of this service - it comes from a tenant's own
 * uploaded policy document, which is not guaranteed to be free of prompt
 * injection attempts. The Milestone 3 agent must never treat it as
 * instructions. See PROJECT.md's retrieval contract section.
 */
@Injectable()
export class PolicyRetrievalService {
  private readonly logger = new Logger(PolicyRetrievalService.name);

  constructor(
    @Inject(RETRIEVAL_SETTINGS) private readonly settings: RetrievalSettings,
    @Inject(LLM_PROVIDER) private readonly llmProvider: LlmProvider,
    @Inject(LLM_SETTINGS) private readonly llmSettings: LlmSettings,
    @Optional() @Inject(POLICY_CHUNK_REPOSITORY) private readonly chunkRepository?: PolicyChunkRepository,
  ) {}

  async retrieve(tenantId: string, query: string, options: RetrieveOptions = {}): Promise<RetrieveOutcome> {
    const startedAt = Date.now();

    if (query.trim().length === 0) {
      return { ok: false, error: { code: 'INVALID_QUERY', message: 'Query must not be blank.' } };
    }
    if (query.length > this.settings.maxQueryLength) {
      return { ok: false, error: { code: 'INVALID_QUERY', message: `Query exceeds the ${this.settings.maxQueryLength}-character limit.` } };
    }

    const requestedTopK = options.topK ?? this.settings.defaultTopK;
    if (!isPositiveInteger(requestedTopK)) {
      return { ok: false, error: { code: 'INVALID_QUERY', message: 'topK must be a positive integer.' } };
    }
    // A hard cap, not a rejection - asking for too many just gets fewer than asked, never an error.
    const topK = Math.min(requestedTopK, this.settings.maxTopK);

    if (!this.llmSettings.geminiApiKey) {
      return { ok: false, error: { code: 'NOT_CONFIGURED', message: 'The embedding provider is not configured.' } };
    }
    if (!this.chunkRepository) {
      return { ok: false, error: { code: 'NOT_CONFIGURED', message: 'The database is not configured.' } };
    }

    const embedResult = await this.llmProvider.embed([query], 'RETRIEVAL_QUERY');
    if (!embedResult.ok) {
      const code = embedResult.error.code === 'NOT_CONFIGURED' ? 'NOT_CONFIGURED' : 'EMBEDDING_FAILED';
      return { ok: false, error: { code, message: embedResult.error.message } };
    }
    const queryVector = embedResult.result.vectors[0].values;

    let rawResults: VectorSearchResultItem[];
    try {
      rawResults = await this.chunkRepository.vectorSearch({ tenantId, queryVector, limit: topK, exact: options.exact });
    } catch (err) {
      // Covers an index that isn't queryable yet (e.g. freshly created, see
      // db:ensure-indexes) and any other search-layer failure - never the
      // raw driver error to the caller, logged internally instead.
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(`vectorSearch failed for tenant ${tenantId}: ${message}`);
      return { ok: false, error: { code: 'SEARCH_UNAVAILABLE', message: 'Search is temporarily unavailable.' } };
    }

    // Defense in depth: the pre-filter should make this structurally
    // impossible, but this is the one place a tenant-isolation bug would
    // actually leak data, so it's asserted again here rather than trusted.
    const crossTenantCount = rawResults.filter((r) => r.tenantId !== tenantId).length;
    const sameTenant = rawResults.filter((r) => r.tenantId === tenantId);
    if (crossTenantCount > 0) {
      this.logger.error(`DEFENSE_IN_DEPTH_CROSS_TENANT_RESULT: dropped ${crossTenantCount} result(s) not belonging to tenant ${tenantId}`);
    }

    const staleModelCount = sameTenant.filter(
      (r) => r.embeddingModel !== EMBEDDING_MODEL || r.embeddingDimension !== EMBEDDING_DIMENSION,
    ).length;
    const current = sameTenant.filter((r) => r.embeddingModel === EMBEDDING_MODEL && r.embeddingDimension === EMBEDDING_DIMENSION);
    if (staleModelCount > 0) {
      this.logger.warn(`STALE_EMBEDDING_CONFIG_SKIPPED: skipped ${staleModelCount} result(s) embedded with a different model/dimension`);
    }

    const results: RetrievalResult[] = current.map((r) => ({
      chunkKey: `${r.documentId}-${r.position}`,
      documentId: r.documentId,
      documentTitle: r.title,
      headingPath: r.headingPath,
      text: r.text,
      position: r.position,
      score: r.score,
    }));

    const durationMs = Date.now() - startedAt;
    const topScore = results.length > 0 ? results[0].score : null;
    // Never the query text or chunk text - only shape/outcome.
    this.logger.log(
      JSON.stringify({ event: 'policy_retrieve', tenantId, queryLength: query.length, resultCount: results.length, topScore, durationMs }),
    );

    return { ok: true, results };
  }
}
