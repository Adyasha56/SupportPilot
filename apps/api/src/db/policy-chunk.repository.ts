import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, PipelineStage, Types } from 'mongoose';
import { POLICY_CHUNK_VECTOR_INDEX_NAME, PolicyChunkDocument } from './schemas/policy-chunk.schema';

export interface NewPolicyChunk {
  tenantId: string;
  documentId: string;
  title: string;
  position: number;
  text: string;
  embedding: number[];
  embeddingModel: string;
  embeddingDimension: number;
  contentHash: string;
}

export interface VectorSearchParams {
  tenantId: string;
  queryVector: number[];
  limit: number;
  /** Defaults to 20x limit per Atlas's own guidance. Ignored when exact is true. */
  numCandidates?: number;
  /**
   * ENN (exact nearest neighbor) instead of ANN. Recommended for small
   * corpora and tests, where approximate search could non-deterministically
   * miss the "true" top-k and make assertions flaky; production retrieval
   * (Milestone 3+) uses the default ANN path for speed as corpora grow.
   */
  exact?: boolean;
}

export interface VectorSearchResultItem {
  chunkId: string;
  documentId: string;
  title: string;
  text: string;
  score: number;
}

export interface PolicyChunkRepository {
  insertMany(chunks: NewPolicyChunk[]): Promise<void>;
  activateForDocument(tenantId: string, documentId: string): Promise<void>;
  deleteForDocument(tenantId: string, documentId: string): Promise<void>;
  /** Test cleanup only - deletes by tenantId, never dropDatabase. */
  deleteForTenant(tenantId: string): Promise<void>;
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

  async insertMany(chunks: NewPolicyChunk[]): Promise<void> {
    if (chunks.length === 0) {
      return;
    }
    await this.model.insertMany(
      chunks.map((chunk) => ({ ...chunk, documentId: new Types.ObjectId(chunk.documentId), active: false })),
    );
  }

  async activateForDocument(tenantId: string, documentId: string): Promise<void> {
    await this.model.updateMany({ tenantId, documentId: new Types.ObjectId(documentId) }, { $set: { active: true } });
  }

  async deleteForDocument(tenantId: string, documentId: string): Promise<void> {
    await this.model.deleteMany({ tenantId, documentId: new Types.ObjectId(documentId) });
  }

  async deleteForTenant(tenantId: string): Promise<void> {
    await this.model.deleteMany({ tenantId });
  }

  async vectorSearch(params: VectorSearchParams): Promise<VectorSearchResultItem[]> {
    const { tenantId, queryVector, limit, exact } = params;
    const numCandidates = params.numCandidates ?? Math.max(limit * 20, limit);

    const pipeline: PipelineStage[] = [
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
          documentId: { $toString: '$documentId' },
          title: 1,
          text: 1,
          score: { $meta: 'vectorSearchScore' },
        },
      },
    ];

    return this.model.aggregate<VectorSearchResultItem>(pipeline);
  }
}
