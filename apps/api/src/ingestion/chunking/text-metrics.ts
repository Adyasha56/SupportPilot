/**
 * Character-based approximation (~4 chars/token), not a real tokenizer -
 * matches the same approximation already used for Gemini's input limit in
 * apps/api/src/llm/llm.settings.ts, so both places are consistent about
 * what "a token" means in this codebase.
 */
export function approxTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export function tokensToChars(tokens: number): number {
  return tokens * 4;
}

/**
 * True if `index` sits between the two UTF-16 code units of a surrogate
 * pair (an astral character, e.g. most emoji) - cutting a string there
 * with plain slice() would produce two invalid half-characters. `index` is
 * a cut point (the string is split as text.slice(0,index) + text.slice(index)),
 * so it's unsafe exactly when the code unit immediately before it is a high
 * surrogate AND the one at it is a low surrogate.
 */
export function isUnsafeSurrogateCut(text: string, index: number): boolean {
  if (index <= 0 || index >= text.length) {
    return false;
  }
  const before = text.charCodeAt(index - 1);
  const at = text.charCodeAt(index);
  const isHighSurrogate = before >= 0xd800 && before <= 0xdbff;
  const isLowSurrogate = at >= 0xdc00 && at <= 0xdfff;
  return isHighSurrogate && isLowSurrogate;
}

/** Nudges a cut point backward until it no longer splits a surrogate pair. Never goes below 0. */
export function nearestSafeCut(text: string, index: number): number {
  let cut = index;
  while (cut > 0 && isUnsafeSurrogateCut(text, cut)) {
    cut -= 1;
  }
  return cut;
}
