import { describe, expect, it } from 'vitest';
import { headingPathLabel, mergeTinySections, parseHeadingSections, splitLines, trimSection } from './heading-sections';

describe('splitLines', () => {
  it('reconstructs the original content exactly by joining line texts with \\n', () => {
    const content = 'a\nb\nc';
    const lines = splitLines(content);
    expect(lines.map((l) => l.text).join('\n')).toBe(content);
  });

  it('every line slice matches content.slice(start, end) minus the trailing newline', () => {
    const content = 'first\nsecond\nthird';
    const lines = splitLines(content);
    for (const line of lines) {
      expect(content.slice(line.start, line.end)).toBe(line === lines[lines.length - 1] ? line.text : `${line.text}\n`);
    }
  });
});

describe('parseHeadingSections', () => {
  it('returns one section with an empty heading path when there are no headings', () => {
    const content = 'Just some text.\nAnother line.';
    const sections = parseHeadingSections(content);
    expect(sections).toHaveLength(1);
    expect(sections[0].headingPath).toEqual([]);
    expect(content.slice(sections[0].start, sections[0].end)).toBe(content);
  });

  it('builds a heading path stack across nested levels', () => {
    const content = '# Refund Policy\n\nIntro.\n\n## Late Delivery\n\nLate text.\n\n### Edge Cases\n\nEdge text.';
    const sections = parseHeadingSections(content);
    const paths = sections.map((s) => s.headingPath);
    expect(paths).toEqual([[], ['Refund Policy'], ['Refund Policy', 'Late Delivery'], ['Refund Policy', 'Late Delivery', 'Edge Cases']]);
  });

  it('pops back to the correct ancestor when a heading level skips (h1 then h3 then h2)', () => {
    const content = '# A\n\nx\n\n### B\n\ny\n\n## C\n\nz';
    const sections = parseHeadingSections(content);
    const paths = sections.map((s) => s.headingPath);
    expect(paths).toEqual([[], ['A'], ['A', 'B'], ['A', 'C']]);
  });

  it('ignores "#" lines inside fenced code blocks', () => {
    const content = '# Real Heading\n\n```\n# not a heading\n```\n\nMore text.';
    const sections = parseHeadingSections(content);
    expect(sections.map((s) => s.headingPath)).toEqual([[], ['Real Heading']]);
    const body = content.slice(sections[1].start, sections[1].end);
    expect(body).toContain('# not a heading');
  });

  it('handles duplicate heading titles at the same level as distinct sections', () => {
    const content = '# Policy\n\na\n\n## Notes\n\nfirst\n\n## Notes\n\nsecond';
    const sections = parseHeadingSections(content);
    expect(sections.map((s) => s.headingPath)).toEqual([[], ['Policy'], ['Policy', 'Notes'], ['Policy', 'Notes']]);
  });

  it('a heading-only document (no body text anywhere) does not crash', () => {
    const content = '# A\n## B\n### C';
    const sections = parseHeadingSections(content);
    expect(sections.length).toBeGreaterThan(0);
    for (const section of sections) {
      expect(section.end).toBeGreaterThanOrEqual(section.start);
    }
  });
});

describe('trimSection', () => {
  it('moves offsets to skip surrounding whitespace, never re-deriving text separately', () => {
    const content = 'before\n\n   padded text   \n\nafter';
    const padded = '   padded text   ';
    const start = content.indexOf(padded);
    const end = start + padded.length;
    const trimmed = trimSection(content, { headingPath: [], start, end });
    expect(content.slice(trimmed.start, trimmed.end)).toBe('padded text');
  });
});

describe('mergeTinySections', () => {
  // "## Tiny" and "## NotTiny" are SIBLINGS (same parent: "Policy"), which is
  // the case mergeTinySections actually handles - a heading and its own
  // child are parent/child, never siblings of each other, so a parent
  // section is never a valid merge target for its own child.
  it('merges a tiny sibling backward into the preceding sibling under the same parent', () => {
    const content =
      '# Policy\n\nRoot intro.\n\n## NotTiny\n\nLong enough content that is not tiny at all, well past the merge threshold here.\n\n## Tiny\n\nx';
    const raw = parseHeadingSections(content);
    const merged = mergeTinySections(content, raw, 10);

    expect(merged.some((s) => headingPathLabel(s.headingPath) === 'Policy > Tiny')).toBe(false);
    const survivor = merged.find((s) => headingPathLabel(s.headingPath) === 'Policy > NotTiny');
    expect(survivor).toBeDefined();
    const survivorText = content.slice(survivor!.start, survivor!.end);
    expect(survivorText).toContain('Long enough content');
    expect(survivorText).toContain('x'); // "## Tiny"'s own body, absorbed
  });

  it('merges a tiny leading sibling forward when there is no preceding sibling', () => {
    const content = '# Policy\n\n## Tiny\n\nx\n\n## Long\n\nThis sibling has plenty of content to stay well above the merge threshold here.';
    const raw = parseHeadingSections(content);
    const merged = mergeTinySections(content, raw, 10);

    expect(merged.some((s) => headingPathLabel(s.headingPath) === 'Policy > Tiny')).toBe(false);
    const survivorForLong = merged.find((s) => headingPathLabel(s.headingPath) === 'Policy > Long');
    expect(survivorForLong).toBeDefined();
    // Forward merge absorbs the tiny sibling's own BODY ("x"); unlike
    // backward merge, it does not reach back far enough to also include
    // that sibling's OWN heading line, since that line sits in the gap
    // BEFORE the tiny section's start, which forward merge never crosses.
    expect(content.slice(survivorForLong!.start, survivorForLong!.end)).toContain('x');
  });

  it('leaves an only-child tiny section alone when there is no same-parent sibling to merge into', () => {
    const content =
      '# Policy\n\nLong enough content under the parent to not itself be tiny, well above threshold text here.\n\n## OnlyChild\n\nx';
    const raw = parseHeadingSections(content);
    const merged = mergeTinySections(content, raw, 10);

    // "## OnlyChild" has no sibling (it's the only section whose parent is
    // "Policy"), and its own parent "Policy" isn't a valid merge target
    // (parent/child, not siblings) - so it stays, even though it's tiny.
    expect(merged.some((s) => headingPathLabel(s.headingPath) === 'Policy > OnlyChild')).toBe(true);
  });

  it('every merged section still satisfies content.slice(start,end) producing contiguous, valid text', () => {
    const content = '# A\n\n## B\n\nshort\n\n## C\n\nshort2\n\n## D\n\nThis one is long enough on its own to clear the merge threshold easily.';
    const raw = parseHeadingSections(content);
    const merged = mergeTinySections(content, raw, 15);
    for (const section of merged) {
      expect(section.end).toBeGreaterThanOrEqual(section.start);
      expect(() => content.slice(section.start, section.end)).not.toThrow();
    }
  });
});
