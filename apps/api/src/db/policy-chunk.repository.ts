import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { ClientSession, Model, PipelineStage, Types } from 'mongoose';
import { POLICY_CHUNK_VECTOR_INDEX_NAME, PolicyChunkDocument } from './schemas/policy-chunk.schema';

export interface NewPolicyChunk {
  tenantId: string;
  documentId: string;
  title: string;
  headingPath: string;
  position: number;
  text: string;
  embedding: number[];
  embeddingModel: string;
  embeddingDimension: number;
  contentHash: string;
}

/** Atlas's own hard maximum - confirmed directly against current MongoDB docs (not assumed): "Value must be less than or equal to (<=) 10000." */
export const ATLAS_MAX_NUM_CANDIDATES = 10_000;

export interface VectorSearchParams {
  tenantId: string;
  queryVector: number[];
  limit: number;
  /** Defaults to 20x limit per Atlas's own guidance, capped at ATLAS_MAX_NUM_CANDIDATES. Ignored when exact is true. */
  numCandidates?: number;
  /**
   * ENN (exact nearest neighbor) instead of ANN. Recommended for small
   * corpora and tests, where approximate search could non-deterministically
   * miss the "true" top-k and make assertions flaky; production retrieval
   * uses the default ANN path for speed as corpora grow.
   */
  exact?: boolean;
}

export interface VectorSearchResultItem {
  chunkId: string;
  tenantId: string;
  documentId: string;
  title: string;
  headingPath: string;
  text: string;
  position: number;
  embeddingModel: string;
  embeddingDimension: number;
  /**
   * Atlas's own `vectorSearchScore`, unchanged - for a cosine-similarity
   * index this is normalized to [0, 1] via (1 + cosine) / 2, NOT the raw
   * cosine value (see packages/shared's retrieval.schema.ts for the full
   * citation/caveat). Exposed as-is; no relevance threshold applied here.
   */
  score: number;
}

/**
 * A pure function, not a repository method, specifically so it can be unit
 * tested without mocking Mongoose at all: the test just calls this and
 * inspects the returned pipeline array directly. tenantId and active:true
 * are BOTH applied as $vectorSearch pre-filters (the index declares them
 * as "filter"-type fields) - never a post-filter on top-k results. A
 * pre-filter narrows the HNSW graph traversal itself before the ANN search
 * runs, so a tenant's results can never include another tenant's or an
 * inactive document's chunks even when those are the closer vector matches.
 */
export function buildVectorSearchPipeline(params: VectorSearchParams): PipelineStage[] {
  const { tenantId, queryVector, limit, exact } = params;
  const numCandidates = Math.min(params.numCandidates ?? Math.max(limit * 20, limit), ATLAS_MAX_NUM_CANDIDATES);

  return [
    {
      $vectorSearch: {
        index: POLICY_CHUNK_VECTOR_INDEX_NAME,
        path: 'embedding',
        queryVector,
        filter: { tenantId, active: true },
        limit,
        ...(exact ? { exact: true } : { numCandidates }),
      },
    },
    {
      // Explicitly excludes `embedding` from the output - this is the
      // real enforcement for aggregation results. The schema's
      // select:false only protects plain find()/findOne() calls; it does
      // not automatically apply to raw aggregate() pipelines.
      $project: {
        _id: 0,
        chunkId: { $toString: '$_id' },
        tenantId: 1,
        documentId: { $toString: '$documentId' },
        title: 1,
        headingPath: 1,
        text: 1,
        position: 1,
        embeddingModel: 1,
        embeddingDimension: 1,
        score: { $meta: 'vectorSearchScore' },
      },
    },
  ];
}

export interface PolicyChunkRepository {
  /**
   * Chunks are inserted already `active: true`, inside the same
   * transaction (session) that also marks the parent document `ready` -
   * confirmed empirically that multi-document transactions work on this
   * project's Atlas M0 cluster (see docs/learning-notes.md), so there is
   * no separate "insert inactive, then activate" phase to begin with.
   */
  insertMany(chunks: NewPolicyChunk[], session?: ClientSession): Promise<void>;
  /** First step of delete (see policies.controller.ts): stop new reads from seeing these chunks before they're physically removed. */
  deactivateForDocument(tenantId: string, documentId: string): Promise<void>;
  deleteForDocument(tenantId: string, documentId: string): Promise<void>;
  /**
   * Used only by the stale-pending cleanup sweep. Scoped to `active:
   * false` specifically - a pending document should structurally never
   * have any active chunks (chunks only ever become active inside the
   * same transaction that marks a document ready), but this makes that a
   * hard guarantee rather than an assumption: even if some future bug
   * left an active chunk under a document the sweep is about to fail,
   * this never deletes it.
   */
  deleteInactiveForDocument(tenantId: string, documentId: string): Promise<void>;
  /** Test cleanup only - deletes by tenantId, never dropDatabase. */
  deleteForTenant(tenantId: string): Promise<void>;
  /** Used for the tenant chunk quota - counts all chunks regardless of active state (inactive ones are rare and transient, only existing mid-delete). */
  countForTenant(tenantId: string): Promise<number>;
  /**
   * tenantId and active are BOTH applied as $vectorSearch pre-filters (the
   * index declares them as "filter"-type fields) - never a post-filter on
   * top-k results. A pre-filter narrows the HNSW graph traversal itself
   * before the ANN search runs, so a tenant's results can never include
   * another tenant's or an inactive document's chunks even when those are
   * the closer vector matches.
   */
  vectorSearch(params: VectorSearchParams): Promise<VectorSearchResultItem[]>;
}

export const POLICY_CHUNK_REPOSITORY = Symbol('POLICY_CHUNK_REPOSITORY');

@Injectable()
export class MongoosePolicyChunkRepository implements PolicyChunkRepository {
  constructor(@InjectModel('PolicyChunk') private readonly model: Model<PolicyChunkDocument>) {}

  async insertMany(chunks: NewPolicyChunk[], session?: ClientSession): Promise<void> {
    if (chunks.length === 0) {
      return;
    }
    await this.model.insertMany(
      chunks.map((chunk) => ({ ...chunk, documentId: new Types.ObjectId(chunk.documentId), active: true })),
      { session },
    );
  }

  async deactivateForDocument(tenantId: string, documentId: string): Promise<void> {
    await this.model.updateMany({ tenantId, documentId: new Types.ObjectId(documentId) }, { $set: { active: false } });
  }

  async deleteForDocument(tenantId: string, documentId: string): Promise<void> {
    await this.model.deleteMany({ tenantId, documentId: new Types.ObjectId(documentId) });
  }

  async deleteInactiveForDocument(tenantId: string, documentId: string): Promise<void> {
    await this.model.deleteMany({ tenantId, documentId: new Types.ObjectId(documentId), active: false });
  }

  async deleteForTenant(tenantId: string): Promise<void> {
    await this.model.deleteMany({ tenantId });
  }

  async countForTenant(tenantId: string): Promise<number> {
    return this.model.countDocuments({ tenantId });
  }

  async vectorSearch(params: VectorSearchParams): Promise<VectorSearchResultItem[]> {
    return this.model.aggregate<VectorSearchResultItem>(buildVectorSearchPipeline(params));
  }
}
