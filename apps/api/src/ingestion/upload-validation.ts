const ALLOWED_EXTENSIONS = ['.md', '.txt'];
const CONTROL_CHAR_RE = /[\u0000-\u001f\u007f]/g;
const DEFAULT_TITLE = 'Untitled policy';

/**
 * Extension only - the client-supplied Content-Type/mimetype is never
 * trusted (it's attacker-controlled and routinely wrong), so it plays no
 * part in this check at all.
 */
export function hasAllowedExtension(originalname: string): boolean {
  const lower = originalname.toLowerCase();
  return ALLOWED_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

/**
 * Strict UTF-8 decoding - `fatal: true` makes TextDecoder throw on any
 * invalid byte sequence instead of silently substituting U+FFFD, which
 * would otherwise corrupt content without any sign something was wrong.
 * Returns null on invalid input rather than throwing, so callers get a
 * normal typed-error path instead of a try/catch.
 */
export function decodeStrictUtf8(buffer: Buffer): string | null {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch {
    return null;
  }
}

export function containsNulByte(text: string): boolean {
  return text.includes('\u0000');
}

/**
 * Strips control characters (including NUL - belt-and-suspenders with
 * containsNulByte's hard rejection on the body text), trims, caps length,
 * and falls back to a default when nothing usable is left - never an
 * empty string, which would otherwise render as a blank title.
 */
export function sanitizeTitle(rawTitle: string | undefined, maxLength: number): string {
  const cleaned = (rawTitle ?? '').replace(CONTROL_CHAR_RE, '').trim();
  if (cleaned.length === 0) {
    return DEFAULT_TITLE;
  }
  return cleaned.slice(0, maxLength);
}
