import { nearestSafeCut, tokensToChars } from './text-metrics';
import { splitLines } from './heading-sections';

export interface AtomicZone {
  start: number;
  end: number;
}

const FENCE_RE = /^(`{3,}|~{3,})/;

/**
 * Fenced code blocks and contiguous table-row blocks, as [start,end) spans
 * within [sectionStart, sectionEnd) - these are never split internally
 * unless the zone alone is larger than the chunk size limit, in which case
 * there is no other option (documented at the call site).
 */
export function findAtomicZones(content: string, sectionStart: number, sectionEnd: number): AtomicZone[] {
  const lines = splitLines(content.slice(sectionStart, sectionEnd)).map((line) => ({
    text: line.text,
    start: line.start + sectionStart,
    end: line.end + sectionStart,
  }));
  const zones: AtomicZone[] = [];

  let i = 0;
  while (i < lines.length) {
    const trimmed = lines[i].text.trim();
    const fenceMatch = FENCE_RE.exec(trimmed);
    if (fenceMatch) {
      const fenceChar = fenceMatch[1][0];
      const fenceLen = fenceMatch[1].length;
      let j = i + 1;
      while (j < lines.length && !lines[j].text.trim().startsWith(fenceChar.repeat(fenceLen))) {
        j++;
      }
      const zoneEndLine = j < lines.length ? j : lines.length - 1;
      zones.push({ start: lines[i].start, end: lines[zoneEndLine].end });
      i = zoneEndLine + 1;
      continue;
    }

    if (trimmed.startsWith('|')) {
      let j = i;
      while (j < lines.length && lines[j].text.trim().startsWith('|')) {
        j++;
      }
      zones.push({ start: lines[i].start, end: lines[j - 1].end });
      i = j;
      continue;
    }

    i++;
  }

  return zones;
}

function isInsideZone(zones: AtomicZone[], pos: number): boolean {
  return zones.some((z) => pos > z.start && pos < z.end);
}

function findBreaks(content: string, start: number, end: number, pattern: RegExp, zones: AtomicZone[]): number[] {
  const span = content.slice(start, end);
  const flags = pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`;
  const re = new RegExp(pattern.source, flags);
  const breaks: number[] = [];
  let match: RegExpExecArray | null;
  while ((match = re.exec(span)) !== null) {
    const pos = start + match.index + match[0].length;
    if (pos > start && pos < end && !isInsideZone(zones, pos)) {
      breaks.push(pos);
    }
    if (match[0].length === 0) {
      re.lastIndex += 1; // guard against a zero-length match looping forever
    }
  }
  return breaks;
}

const PARAGRAPH_BREAK_RE = /\n[ \t]*\n/g;
// Heuristic, not real sentence-boundary detection: a '.', '!' or '?' followed
// by optional closing punctuation/quotes and whitespace. Misses abbreviations
// ("Dr. Smith"), decimals, and similar - acceptable for a chunk-size fallback
// that only needs "a plausible place to cut", not grammatical correctness.
const SENTENCE_BREAK_RE = /[.!?](?=["')\]]*\s)\s*/g;

/**
 * Splits content[sectionStart:sectionEnd) into chunk-sized spans. Tries
 * paragraph breaks first, then sentence breaks, then a hard character cut
 * (always surrogate-pair-safe) as a last resort. A fenced code block or
 * table row is never split internally UNLESS it alone exceeds maxChars, in
 * which case it is hard-split like any other oversized text - there is no
 * other option that keeps the chunk size bound meaningful.
 *
 * Consecutive spans overlap by up to `overlapChars`, and that overlap never
 * extends past `sectionStart` - i.e. it never crosses into a different
 * heading's content, because this function is only ever called with the
 * bounds of a single section.
 */
export function packSection(
  content: string,
  sectionStart: number,
  sectionEnd: number,
  maxTokens: number,
  overlapTokens: number,
): Array<[number, number]> {
  const maxChars = tokensToChars(maxTokens);
  const overlapChars = tokensToChars(overlapTokens);

  if (sectionEnd - sectionStart <= maxChars) {
    return [[sectionStart, sectionEnd]];
  }

  const zones = findAtomicZones(content, sectionStart, sectionEnd);
  const breaks = [
    ...findBreaks(content, sectionStart, sectionEnd, PARAGRAPH_BREAK_RE, zones),
    ...findBreaks(content, sectionStart, sectionEnd, SENTENCE_BREAK_RE, zones),
  ].sort((a, b) => a - b);

  const spans: Array<[number, number]> = [];
  let cursor = sectionStart;

  while (cursor < sectionEnd) {
    const limit = cursor + maxChars;
    let cut = -1;
    for (const candidate of breaks) {
      if (candidate <= cursor) {
        continue;
      }
      if (candidate > limit) {
        break;
      }
      cut = candidate;
    }

    if (cut === -1) {
      // No paragraph/sentence break fits the budget - hard cut. Still
      // surrogate-safe; may still land inside an atomic zone if that zone
      // alone is larger than the whole budget, which is the documented,
      // unavoidable exception.
      cut = nearestSafeCut(content, Math.min(sectionEnd, limit));
    } else {
      cut = nearestSafeCut(content, cut);
    }

    if (cut <= cursor) {
      // Degenerate safety valve (e.g. maxChars smaller than one surrogate
      // pair) - always make forward progress rather than loop forever.
      cut = Math.min(sectionEnd, cursor + 1);
    }

    spans.push([cursor, cut]);
    if (cut >= sectionEnd) {
      break;
    }
    cursor = Math.max(cursor + 1, cut - overlapChars);
  }

  return spans;
}
