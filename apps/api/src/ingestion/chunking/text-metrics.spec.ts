import { describe, expect, it } from 'vitest';
import { approxTokens, isUnsafeSurrogateCut, nearestSafeCut, tokensToChars } from './text-metrics';

describe('approxTokens', () => {
  it('is ceil(length/4)', () => {
    expect(approxTokens('')).toBe(0);
    expect(approxTokens('abcd')).toBe(1);
    expect(approxTokens('abcde')).toBe(2);
  });
});

describe('tokensToChars', () => {
  it('is the inverse scale of approxTokens', () => {
    expect(tokensToChars(100)).toBe(400);
  });
});

describe('surrogate-pair safety', () => {
  const emoji = '😀'; // a single astral character = 2 UTF-16 code units (a surrogate pair)
  const text = `a${emoji}b`;

  it('detects a cut that would split a surrogate pair', () => {
    expect(isUnsafeSurrogateCut(text, 2)).toBe(true); // right between the two code units of the emoji
    expect(isUnsafeSurrogateCut(text, 1)).toBe(false); // before the emoji
    expect(isUnsafeSurrogateCut(text, 3)).toBe(false); // after the emoji
  });

  it('nearestSafeCut nudges backward out of a surrogate pair', () => {
    expect(nearestSafeCut(text, 2)).toBe(1);
    expect(nearestSafeCut(text, 1)).toBe(1); // already safe
    expect(nearestSafeCut(text, 0)).toBe(0);
  });

  it('never produces a lone half-surrogate when used to slice', () => {
    const cut = nearestSafeCut(text, 2);
    const left = text.slice(0, cut);
    const right = text.slice(cut);
    expect(left + right).toBe(text);
    expect([...left].every((ch) => ch.length <= 2)).toBe(true);
  });
});
