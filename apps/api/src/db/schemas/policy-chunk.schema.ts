import { Schema, Types } from 'mongoose';
import { EMBEDDING_DIMENSION } from '@supportpilot/shared';

export const POLICY_CHUNK_VECTOR_INDEX_NAME = 'policy_chunk_vector_index';
/** Re-exported for existing call sites; the single source of truth is `@supportpilot/shared`'s EMBEDDING_DIMENSION. */
export const POLICY_CHUNK_EMBEDDING_DIMENSION = EMBEDDING_DIMENSION;

export interface PolicyChunkDocument {
  _id: Types.ObjectId;
  tenantId: string;
  documentId: Types.ObjectId;
  /** The PARENT DOCUMENT's title, denormalized onto every chunk so a citation can be rendered without an extra lookup (see PROJECT.md section 6's citation shape). */
  title: string;
  /** e.g. "Refund Policy > Late Delivery", or '' - from Stage 4's chunker, kept so retrieval/the reasoning panel can show which section a chunk came from. */
  headingPath: string;
  position: number;
  text: string;
  /** select:false - never returned by find()/findOne() unless explicitly requested. */
  embedding: number[];
  embeddingModel: string;
  embeddingDimension: number;
  /**
   * SHA-256 of `embeddingText` (headingPath + text, the string actually
   * sent to the embedding model) - NOT of the display-only `text` field.
   * This matches what the embedding cache itself keys on
   * (EmbeddingLruCache.key(model, dimension, taskType, <embedded string>)),
   * so the two can never silently diverge.
   */
  contentHash: string;
  /**
   * False until the whole parent document finishes embedding and commits.
   * A pre-filter field in the vector index (alongside tenantId) so retrieval
   * can never see a partially-ingested document's chunks.
   */
  active: boolean;
  createdAt: Date;
}

export const PolicyChunkSchema = new Schema<PolicyChunkDocument>(
  {
    tenantId: { type: String, required: true, index: true },
    documentId: { type: Schema.Types.ObjectId, required: true, index: true },
    title: { type: String, required: true },
    // NOT required: true - an empty string ('', the valid "no heading"
    // case) fails Mongoose's own required check for String paths (it's
    // `v.length > 0`, not `v != null` - confirmed directly, the same
    // category of gotcha as `embedding`'s empty-array case above).
    headingPath: { type: String, default: '' },
    position: { type: Number, required: true },
    text: { type: String, required: true },
    embedding: {
      type: [Number],
      required: true,
      select: false,
      // Mongoose arrays always default to [], so required:true alone does
      // NOT reject an empty array - confirmed directly. Without this
      // validator a chunk could silently save with no embedding at all.
      validate: {
        validator: (value: number[]) => Array.isArray(value) && value.length > 0,
        message: 'embedding must not be empty',
      },
    },
    embeddingModel: { type: String, required: true },
    embeddingDimension: { type: Number, required: true },
    contentHash: { type: String, required: true },
    active: { type: Boolean, required: true, default: false, index: true },
  },
  { collection: 'policyChunks', timestamps: { createdAt: true, updatedAt: false } },
);

/**
 * One index, two filter fields (tenantId, active) plus the vector field.
 * A field used in $vectorSearch's `filter` option MUST be declared as
 * type "filter" here - confirmed directly against current MongoDB docs,
 * not assumed.
 */
export const POLICY_CHUNK_VECTOR_INDEX_DEFINITION = {
  name: POLICY_CHUNK_VECTOR_INDEX_NAME,
  type: 'vectorSearch' as const,
  definition: {
    fields: [
      {
        type: 'vector' as const,
        path: 'embedding',
        numDimensions: POLICY_CHUNK_EMBEDDING_DIMENSION,
        similarity: 'cosine' as const,
      },
      { type: 'filter' as const, path: 'tenantId' },
      { type: 'filter' as const, path: 'active' },
    ],
  },
};
