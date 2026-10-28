/**
 * The embedding model and vector dimension used for every policy chunk.
 * Shared (not duplicated) between the LLM provider that produces vectors
 * and the Mongoose schema that declares the Atlas Vector Search index on
 * them - a mismatch between the two would make retrieval silently return
 * nothing or fail at query time, so there is exactly one source for both.
 *
 * gemini-embedding-001, truncated from its native 3072 dimensions to 768:
 * the smallest of Google's recommended truncation sizes (768, 1536, 3072),
 * chosen to fit comfortably under MongoDB Atlas M0's 512MB storage cap.
 */
export const EMBEDDING_MODEL = 'gemini-embedding-001';
export const EMBEDDING_DIMENSION = 768;
