import { createHash } from 'node:crypto';

/** SHA-256 of the fully normalized (CRLF->LF, front-matter-stripped) text - the same content that will actually be chunked, so two uploads differing only in front matter or line endings are correctly treated as duplicates. */
export function computeContentHash(normalizedText: string): string {
  return createHash('sha256').update(normalizedText, 'utf8').digest('hex');
}
