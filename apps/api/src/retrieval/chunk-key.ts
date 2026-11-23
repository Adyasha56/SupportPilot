/**
 * The single source of truth for `RetrievalResult.chunkKey`'s format
 * (`${documentId}-${position}`) - `policy-retrieval.service.ts` uses
 * `buildChunkKey` at the one place it's constructed; Stage 1c item 2's
 * admin conversation-detail endpoint uses `parseChunkKey` to resolve a
 * historical `citedChunkKeys` entry back to a document/position pair, so
 * it can look up that chunk's CURRENT `headingPath`/title for display.
 *
 * Splitting on the LAST hyphen (never the first) is what makes this safe:
 * `documentId` is a UUID, which already contains hyphens of its own, but
 * `position` is always a plain non-negative integer, which never is - so
 * the last hyphen in the whole key is unambiguously the one `buildChunkKey`
 * itself inserted.
 */
export function buildChunkKey(documentId: string, position: number): string {
  return `${documentId}-${position}`;
}

export interface ParsedChunkKey {
  documentId: string;
  position: number;
}

/** Returns undefined for a malformed key (no hyphen, or a non-integer suffix) rather than throwing - this is only ever used for a best-effort display lookup, never a security-sensitive decision. */
export function parseChunkKey(chunkKey: string): ParsedChunkKey | undefined {
  const lastDash = chunkKey.lastIndexOf('-');
  if (lastDash <= 0 || lastDash === chunkKey.length - 1) {
    return undefined;
  }
  const documentId = chunkKey.slice(0, lastDash);
  const positionText = chunkKey.slice(lastDash + 1);
  if (!/^\d+$/.test(positionText)) {
    return undefined;
  }
  return { documentId, position: Number(positionText) };
}
