import { z } from 'zod';

export const RETRIEVAL_ERROR_CODES = ['NOT_CONFIGURED', 'INVALID_QUERY', 'EMBEDDING_FAILED', 'SEARCH_UNAVAILABLE'] as const;
export const RetrievalErrorCodeSchema = z.enum(RETRIEVAL_ERROR_CODES);
export type RetrievalErrorCode = z.infer<typeof RetrievalErrorCodeSchema>;

/**
 * Never includes the embedding vector - a retrieval result is for citing
 * and reasoning over, never for re-deriving the raw vector.
 *
 * `score` is Atlas's own `vectorSearchScore` for a cosine-similarity index,
 * exposed UNCHANGED (no relevance threshold applied yet - see
 * PolicyRetrievalService's own doc comment for why). Per current MongoDB
 * documentation (cross-checked across several sources - the primary docs
 * page itself could not be fetched directly during verification, this is
 * flagged honestly rather than silently assumed), Atlas normalizes a
 * cosine-similarity score to the range [0, 1] via `(1 + cosine) / 2` -
 * this is NOT the raw cosine similarity value.
 */
export const RetrievalResultSchema = z.object({
  /** `${documentId}-${position}` - stable for a given document/position, not a separately stored field. */
  chunkKey: z.string(),
  documentId: z.string(),
  documentTitle: z.string(),
  /** e.g. "Refund Policy > Late Delivery", or '' for content with no heading. */
  headingPath: z.string(),
  text: z.string(),
  position: z.number().int().nonnegative(),
  score: z.number(),
});
export type RetrievalResult = z.infer<typeof RetrievalResultSchema>;

export const RetrievalResultsSchema = z.array(RetrievalResultSchema);
