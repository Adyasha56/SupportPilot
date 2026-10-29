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

    // Over-fetch: while the index is stale (see the defense-in-depth
    // comment below), a stale candidate can occupy a top-k slot that a
    // genuinely active chunk would otherwise have won, crowding it out
    // before this service ever gets a chance to drop the stale one.
    // Asking for more candidates than the caller needs, filtering, THEN
    // trimming to topK leaves enough headroom for that to self-correct.
    // 2x is a plain, cheap multiplier - well within Atlas's own limits
    // (numCandidates is already capped separately, at 10000, inside
    // buildVectorSearchPipeline).
    const overFetchLimit = topK * 2;

    let rawResults: VectorSearchResultItem[];
    try {
      rawResults = await this.chunkRepository.vectorSearch({ tenantId, queryVector, limit: overFetchLimit, exact: options.exact });
    } catch (err) {
      // Covers an index that isn't queryable yet (e.g. freshly created, see
      // db:ensure-indexes) and any other search-layer failure - never the
      // raw driver error to the caller, logged internally instead.
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(`vectorSearch failed for tenant ${tenantId}: ${message}`);
      return { ok: false, error: { code: 'SEARCH_UNAVAILABLE', message: 'Search is temporarily unavailable.' } };
    }

    // Defense in depth: the $vectorSearch pre-filter should make both of
    // these structurally impossible, but it narrows candidates using the
    // INDEX's own copy of tenantId/active, which is eventually consistent
    // - a just-written active:false (or, in principle, a tenant change)
    // can lag behind for a few seconds. Reproduced directly against this
    // project's own Atlas cluster: a chunk deactivated via
    // deactivateForDocument() was still returned by $vectorSearch
    // immediately afterward (see docs/learning-notes.md for the measured
    // lag). tenantId and active are both read via $project from the
    // matched document itself, which reflects the CURRENT collection
    // value even during that same lag window - confirmed by the same
    // experiment - so checking them here, after the search, is what
    // actually closes the gap the pre-filter's lag leaves open.
    const crossTenantCount = rawResults.filter((r) => r.tenantId !== tenantId).length;
    const sameTenant = rawResults.filter((r) => r.tenantId === tenantId);
    if (crossTenantCount > 0) {
      this.logger.error(`DEFENSE_IN_DEPTH_CROSS_TENANT_RESULT: dropped ${crossTenantCount} result(s) not belonging to tenant ${tenantId}`);
    }

    const inactiveCount = sameTenant.filter((r) => r.active !== true).length;
    const activeOnly = sameTenant.filter((r) => r.active === true);
    if (inactiveCount > 0) {
      // WARN, not ERROR: this is the one case in this block that's a known,
      // expected, self-correcting condition (Atlas's own documented
      // eventual consistency, measured at well under a second for a field
      // update - see docs/learning-notes.md), not a sign something is
      // actually broken. ERROR is reserved for a cross-tenant result,
      // which should never happen regardless of index freshness.
      this.logger.warn(`DEFENSE_IN_DEPTH_INACTIVE_RESULT: dropped ${inactiveCount} inactive result(s) for tenant ${tenantId} (index lag)`);
    }

    const staleModelCount = activeOnly.filter(
      (r) => r.embeddingModel !== EMBEDDING_MODEL || r.embeddingDimension !== EMBEDDING_DIMENSION,
    ).length;
    const current = activeOnly.filter((r) => r.embeddingModel === EMBEDDING_MODEL && r.embeddingDimension === EMBEDDING_DIMENSION);
    if (staleModelCount > 0) {
      this.logger.warn(`STALE_EMBEDDING_CONFIG_SKIPPED: skipped ${staleModelCount} result(s) embedded with a different model/dimension`);
    }

    // Trimmed AFTER filtering, not before - results were over-fetched
    // above specifically so this slice still has topK genuinely valid
    // candidates to choose from even when some of the over-fetched batch
    // had to be dropped.
    const results: RetrievalResult[] = current.slice(0, topK).map((r) => ({
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
