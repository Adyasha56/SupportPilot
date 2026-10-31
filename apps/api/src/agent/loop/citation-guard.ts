import { Citation, MAX_CITED_CHUNK_KEYS, RetrievalResult } from '@supportpilot/shared';

export interface CitationGuardResult {
  citations: Citation[];
  /**
   * One count, three collapsed reasons (never retrieved this turn,
   * duplicate, or over the cap) - deliberately not broken out further.
   * PROJECT.md's logging rule is "counts and outcome codes only, never
   * chunk content" - a dropped chunkKey is itself untrusted, model-claimed
   * text, so even logging WHICH key was dropped (let alone why) would
   * leak more than a count-only log should.
   */
  droppedCount: number;
}

/**
 * The model's own claim of which chunks it used is never trusted at face
 * value (PROJECT.md: "a citedChunkKey the model names but that wasn't
 * really retrieved this turn is dropped, never trusted at face value").
 * This keeps only chunkKeys that are actually present in `retrieved`,
 * dedupes repeats, caps the result at `maxCitations`, and enriches each
 * surviving key with the documentTitle/headingPath straight from the
 * retrieval result - never from anything the model said about the chunk.
 */
export function guardCitations(citedChunkKeys: string[], retrieved: RetrievalResult[], maxCitations: number = MAX_CITED_CHUNK_KEYS): CitationGuardResult {
  const byKey = new Map(retrieved.map((result) => [result.chunkKey, result]));
  const seen = new Set<string>();
  const citations: Citation[] = [];
  let droppedCount = 0;

  for (const key of citedChunkKeys) {
    const match = byKey.get(key);
    if (!match) {
      droppedCount++;
      continue;
    }
    if (seen.has(key)) {
      droppedCount++;
      continue;
    }
    if (citations.length >= maxCitations) {
      droppedCount++;
      continue;
    }
    seen.add(key);
    citations.push({ chunkKey: match.chunkKey, documentTitle: match.documentTitle, headingPath: match.headingPath });
  }

  return { citations, droppedCount };
}
