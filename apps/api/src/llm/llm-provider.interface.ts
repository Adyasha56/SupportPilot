/**
 * generate() is deliberately not part of this interface yet - Milestone 3's
 * agent loop will design its own shape (structured-output schema, retry on
 * invalid JSON, etc.) once there's a real caller. Adding it now, unused,
 * would just be a guess to redo later.
 */

/**
 * RETRIEVAL_DOCUMENT for policy chunks at ingestion time, RETRIEVAL_QUERY
 * for the customer message at retrieval time - asymmetric embeddings, per
 * Gemini's own docs, produce better matches than embedding both sides the
 * same way. Other task types the model supports (classification,
 * clustering, etc.) aren't used anywhere in this project, so they're left
 * out rather than speculatively supported.
 */
export type EmbeddingTaskType = 'RETRIEVAL_DOCUMENT' | 'RETRIEVAL_QUERY';

export interface EmbeddingVector {
  text: string;
  values: number[];
}

export interface EmbedResult {
  vectors: EmbeddingVector[];
  model: string;
  dimension: number;
}

export type EmbedErrorCode = 'NOT_CONFIGURED' | 'INVALID_INPUT' | 'RATE_LIMITED' | 'UNAUTHORIZED' | 'TRANSIENT' | 'UNAVAILABLE';

export interface EmbedError {
  code: EmbedErrorCode;
  message: string;
}

/**
 * A result type, not a thrown exception - matching the tool runner's
 * established pattern (Milestone 1) of never throwing for expected
 * failures. Rate limits, bad input, and a missing API key are all expected,
 * routine outcomes for an embedding call, not exceptional ones.
 */
export type EmbedOutcome = { ok: true; result: EmbedResult } | { ok: false; error: EmbedError };

export interface LlmProvider {
  embed(texts: string[], taskType: EmbeddingTaskType): Promise<EmbedOutcome>;
}
