import { approxTokens } from './text-metrics';

export interface Line {
  text: string;
  start: number;
  /** Start of the next line (i.e. includes this line's own trailing newline), or content.length for the last line. */
  end: number;
}

export function splitLines(content: string): Line[] {
  const lines: Line[] = [];
  let start = 0;
  for (let i = 0; i < content.length; i++) {
    if (content[i] === '\n') {
      lines.push({ text: content.slice(start, i), start, end: i + 1 });
      start = i + 1;
    }
  }
  lines.push({ text: content.slice(start), start, end: content.length });
  return lines;
}

export interface Section {
  /** Ancestor path shared by every heading ever merged into this section (e.g. ["Policy", "Refund Policy"]) - never includes this section's own leaf title(s). Invariant across a merge: mergeTinySections only ever merges same-parent siblings. */
  parentPath: string[];
  /** Leaf title(s) covered by this section, in document order. One element normally; more than one after mergeTinySections absorbs sibling(s). Empty for the span before any heading. */
  titles: string[];
  start: number;
  end: number;
}

// ATX headings only (# through ######), starting at column 0 - CommonMark's
// 1-3-leading-spaces allowance and Setext (underline-style) headings are
// out of scope, kept simple deliberately.
const HEADING_RE = /^(#{1,6})\s+(.+?)\s*$/;
const FENCE_RE = /^(`{3,}|~{3,})/;

/**
 * Splits content into heading-aware sections. A "#" line inside a fenced
 * code block is never treated as a heading - fence state is tracked line
 * by line, toggled only by a closing fence of the same character and at
 * least the same length as the one that opened it.
 */
export function parseHeadingSections(content: string): Section[] {
  const lines = splitLines(content);
  const sections: Section[] = [];
  const headingStack: Array<{ level: number; title: string }> = [];

  let currentStart = 0;
  let inFence = false;
  let fenceChar = '';
  let fenceLen = 0;

  const closeSectionAt = (end: number): void => {
    const parentPath = headingStack.slice(0, -1).map((h) => h.title);
    const titles = headingStack.length > 0 ? [headingStack[headingStack.length - 1].title] : [];
    sections.push({ parentPath, titles, start: currentStart, end });
  };

  for (const line of lines) {
    const trimmed = line.text.trim();

    if (inFence) {
      if (trimmed.startsWith(fenceChar.repeat(fenceLen))) {
        inFence = false;
      }
      continue;
    }

    const fenceMatch = FENCE_RE.exec(trimmed);
    if (fenceMatch) {
      inFence = true;
      fenceChar = fenceMatch[1][0];
      fenceLen = fenceMatch[1].length;
      continue;
    }

    const headingMatch = HEADING_RE.exec(line.text);
    if (!headingMatch) {
      continue;
    }

    closeSectionAt(line.start);
    const level = headingMatch[1].length;
    const title = headingMatch[2];
    while (headingStack.length > 0 && headingStack[headingStack.length - 1].level >= level) {
      headingStack.pop();
    }
    headingStack.push({ level, title });
    currentStart = line.end;
  }

  closeSectionAt(content.length);
  return sections;
}

function isWhitespace(ch: string | undefined): boolean {
  return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r';
}

/** Trims leading/trailing whitespace by moving the OFFSETS, never by re-slicing a separate string - so `content.slice(result.start, result.end)` is always exactly the trimmed text. */
export function trimSection(content: string, section: Section): Section {
  let { start, end } = section;
  while (start < end && isWhitespace(content[start])) {
    start++;
  }
  while (end > start && isWhitespace(content[end - 1])) {
    end--;
  }
  return { parentPath: section.parentPath, titles: section.titles, start, end };
}

function sameParent(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

/**
 * Merges a section below `minMergeTokens` into an adjacent SIBLING (same
 * immediate parent heading) rather than leaving it as its own tiny chunk.
 * A heading and its own child are parent/child, never siblings of each
 * other, so a tiny section's own parent is never a valid merge target.
 *
 * Preference: absorb backward into the previous sibling first, then
 * forward into the next one. Both directions extend one section's offset
 * range to cover the other's, so `content.slice(start, end)` stays exactly
 * correct for every merged chunk too, not just untouched ones - but the
 * two directions aren't quite symmetric: backward merge (prev absorbs
 * current) extends into territory that includes current's OWN heading
 * line (the text "## Tiny" itself becomes inline plain text in the
 * surviving chunk), because that heading line sits in the gap between
 * prev's old end and current's start. Forward merge (next absorbs
 * current) only reaches current's own trimmed body start, which is
 * already past current's heading line, so that heading line is dropped
 * rather than inlined. Both are correct and offset-consistent; this is
 * just a cosmetic difference in whether a stray "## Heading" line ends up
 * inside the merged chunk's body text.
 *
 * Every merged-in section's title is kept, in document order, in the
 * surviving section's `titles` array - the resulting label (see
 * headingPathLabel) lists every topic a merged chunk actually covers,
 * rather than silently keeping only one survivor's title and dropping the
 * others from the label entirely (the earlier behavior - a real problem,
 * not a hypothetical: on this project's own sample policy, the merged
 * "Refund Policy" chunk's label used to read only "Standard Refund
 * Window" even though the same chunk also covers final-sale items,
 * damaged items, double refunds, and the approval threshold).
 *
 * A tiny section with no same-parent neighbor (an only child) is left as
 * its own chunk - merging it into unrelated content under a different
 * heading would misrepresent what the chunk is about.
 */
export function mergeTinySections(content: string, rawSections: Section[], minMergeTokens: number): Section[] {
  const trimmed = rawSections.map((s) => trimSection(content, s));

  const backwardPass: Section[] = [];
  for (const section of trimmed) {
    const prev = backwardPass[backwardPass.length - 1];
    const text = content.slice(section.start, section.end);
    if (prev && sameParent(prev.parentPath, section.parentPath) && approxTokens(text) < minMergeTokens) {
      // prev comes first in the document - prev's titles stay first.
      prev.end = section.end;
      prev.titles = [...prev.titles, ...section.titles];
      continue;
    }
    backwardPass.push({ ...section });
  }

  const result: Section[] = [...backwardPass];
  for (let i = 0; i < result.length - 1; i++) {
    const text = content.slice(result[i].start, result[i].end);
    if (approxTokens(text) < minMergeTokens && sameParent(result[i].parentPath, result[i + 1].parentPath)) {
      // result[i] comes first in the document - its titles go first.
      result[i + 1] = { ...result[i + 1], start: result[i].start, titles: [...result[i].titles, ...result[i + 1].titles] };
      result.splice(i, 1);
      i -= 1;
    }
  }

  return result;
}

/**
 * No system or storage constraint drives this number (PolicyChunk.headingPath
 * has no length limit of its own) - it exists only so a long chain of merged
 * titles can't produce an unbounded label. Chosen generously: long enough to
 * show several merged titles in full on a realistic policy document (see
 * docs/learning-notes.md's Stage 9 entry for the real sample-policy.md
 * numbers), short enough to stay a one-line label, not a paragraph.
 */
export const MAX_HEADING_LABEL_LENGTH = 150;
const ELLIPSIS = '...';

/**
 * "Parent > Path > title1; title2; title3", in full, never truncated - the
 * complete record of every section merged into this chunk. This is the
 * version embeddingText is built from (see markdown-chunker.ts): a
 * display-only truncation must never silently remove real topic
 * information from what's actually sent to the embedding model, only from
 * what's shown to a human.
 */
export function fullHeadingPathLabel(section: Pick<Section, 'parentPath' | 'titles'>): string {
  const parentPart = section.parentPath.join(' > ');
  const titlePart = section.titles.join('; ');
  return parentPart.length === 0 ? titlePart : titlePart.length === 0 ? parentPart : `${parentPart} > ${titlePart}`;
}

/**
 * The DISPLAY/citation version of fullHeadingPathLabel - capped at
 * MAX_HEADING_LABEL_LENGTH and truncated (from the end, with an ellipsis)
 * if longer. Truncating the END naturally keeps the parent path and the
 * earliest-merged titles intact and only ever drops the LATER titles in a
 * long merge chain, since those are the ones nearest the end of the
 * string. Never used to build embeddingText - see fullHeadingPathLabel.
 */
export function headingPathLabel(section: Pick<Section, 'parentPath' | 'titles'>): string {
  const full = fullHeadingPathLabel(section);
  if (full.length <= MAX_HEADING_LABEL_LENGTH) {
    return full;
  }
  return `${full.slice(0, MAX_HEADING_LABEL_LENGTH - ELLIPSIS.length)}${ELLIPSIS}`;
}
