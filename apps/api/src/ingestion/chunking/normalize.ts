/** CRLF -> LF only, as specified - lone CR (old classic-Mac line endings) is out of scope. */
export function normalizeLineEndings(raw: string): string {
  return raw.replace(/\r\n/g, '\n');
}

/**
 * Strips a leading YAML front-matter block (--- ... ---) if one is well
 * formed: the very first line is exactly "---", and some later line is
 * also exactly "---" (or "..."), both strictly on. If no closing delimiter
 * is found, the text is left untouched - a lone "---" at the top of a
 * document that isn't actually front matter (e.g. a horizontal rule
 * immediately after a one-line title) is far less likely than a real
 * front-matter block, but this function never guesses; it only strips a
 * complete, well-formed block.
 */
export function stripFrontMatter(normalized: string): string {
  if (!normalized.startsWith('---\n') && normalized !== '---') {
    return normalized;
  }

  const lines = normalized.split('\n');
  if (lines[0] !== '---') {
    return normalized;
  }

  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === '---' || lines[i] === '...') {
      // +1 for the newline after the closing delimiter line, if there is one.
      const closingLineEnd = lines.slice(0, i + 1).join('\n').length;
      const stripTo = normalized[closingLineEnd] === '\n' ? closingLineEnd + 1 : closingLineEnd;
      return normalized.slice(stripTo);
    }
  }

  return normalized;
}
