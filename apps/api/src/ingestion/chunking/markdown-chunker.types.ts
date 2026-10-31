export interface ChunkerOptions {
  /** Used to build each chunk's stable chunkKey ("<slug>-<position>"). */
  documentSlug: string;
  /** Approximate token target per chunk. Default 400 (the middle of the 300-500 range). */
  targetTokens?: number;
  /** Sections at or below this size get merged into a neighboring sibling rather than left as their own tiny chunk. Default 100. */
  minMergeTokens?: number;
  /** Approximate overlap between consecutive chunks split from the same section. Never crosses a heading boundary. Default 50. */
  overlapTokens?: number;
  /** Exceeding this many chunks is a typed error, never a silent truncation. Default 500. */
  maxChunks?: number;
}

export interface Chunk {
  position: number;
  /** `${documentSlug}-${position}` - stable across re-chunking the same document with the same options. */
  chunkKey: string;
  /** e.g. "Refund Policy > Late Delivery", or '' for content before any heading. DISPLAY/citation only - capped at MAX_HEADING_LABEL_LENGTH (heading-sections.ts) and truncated with "..." for a long merge chain. Never used to build embeddingText - see headingTitles. */
  headingPath: string;
  /** Every section title merged into this chunk, in document order, NEVER truncated (unlike headingPath) - the structured source embeddingText's full heading path is built from. One element normally; more after mergeTinySections absorbs sibling(s); empty for content before any heading. */
  headingTitles: string[];
  /** Clean body text, for display. Always exactly `content.slice(startOffset, endOffset)` of the normalized, front-matter-stripped content - never the raw input string. */
  text: string;
  /** What should actually be sent to the embedding model: the FULL, untruncated heading path (parentPath + every title in headingTitles, never the capped headingPath) + a blank line + text, so a chunk about "30 days" still carries every policy topic it belongs to, even past headingPath's display cap. Hash THIS string for the embedding cache key, not `text`. */
  embeddingText: string;
  approxTokens: number;
  /** Offsets into the normalized, front-matter-stripped content (not the raw input). */
  startOffset: number;
  endOffset: number;
}

export type ChunkingErrorCode = 'EMPTY_INPUT' | 'TOO_MANY_CHUNKS';

export interface ChunkingError {
  code: ChunkingErrorCode;
  message: string;
}

/** A result type, not a thrown exception - same pattern as EmbedOutcome in apps/api/src/llm. */
export type ChunkingOutcome = { ok: true; chunks: Chunk[] } | { ok: false; error: ChunkingError };
