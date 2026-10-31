import { describe, expect, it } from 'vitest';
import { headingPathLabel, MAX_HEADING_LABEL_LENGTH, mergeTinySections, parseHeadingSections, splitLines, trimSection } from './heading-sections';

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
  it('returns one section with an empty parent path and no titles when there are no headings', () => {
    const content = 'Just some text.\nAnother line.';
    const sections = parseHeadingSections(content);
    expect(sections).toHaveLength(1);
    expect(sections[0].parentPath).toEqual([]);
    expect(sections[0].titles).toEqual([]);
    expect(content.slice(sections[0].start, sections[0].end)).toBe(content);
  });

  it('builds a parent path and a single-element titles array across nested levels', () => {
    const content = '# Refund Policy\n\nIntro.\n\n## Late Delivery\n\nLate text.\n\n### Edge Cases\n\nEdge text.';
    const sections = parseHeadingSections(content);
    expect(sections.map((s) => ({ parentPath: s.parentPath, titles: s.titles }))).toEqual([
      { parentPath: [], titles: [] },
      { parentPath: [], titles: ['Refund Policy'] },
      { parentPath: ['Refund Policy'], titles: ['Late Delivery'] },
      { parentPath: ['Refund Policy', 'Late Delivery'], titles: ['Edge Cases'] },
    ]);
  });

  it('pops back to the correct ancestor when a heading level skips (h1 then h3 then h2)', () => {
    const content = '# A\n\nx\n\n### B\n\ny\n\n## C\n\nz';
    const sections = parseHeadingSections(content);
    expect(sections.map((s) => [s.parentPath, s.titles])).toEqual([
      [[], []],
      [[], ['A']],
      [['A'], ['B']],
      [['A'], ['C']],
    ]);
  });

  it('ignores "#" lines inside fenced code blocks', () => {
    const content = '# Real Heading\n\n```\n# not a heading\n```\n\nMore text.';
    const sections = parseHeadingSections(content);
    expect(sections.map((s) => s.titles)).toEqual([[], ['Real Heading']]);
    const body = content.slice(sections[1].start, sections[1].end);
    expect(body).toContain('# not a heading');
  });

  it('handles duplicate heading titles at the same level as distinct sections', () => {
    const content = '# Policy\n\na\n\n## Notes\n\nfirst\n\n## Notes\n\nsecond';
    const sections = parseHeadingSections(content);
    expect(sections.map((s) => s.titles)).toEqual([[], ['Policy'], ['Notes'], ['Notes']]);
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
    const trimmed = trimSection(content, { parentPath: [], titles: [], start, end });
    expect(content.slice(trimmed.start, trimmed.end)).toBe('padded text');
  });

  it('carries parentPath and titles through unchanged', () => {
    const content = '  x  ';
    const trimmed = trimSection(content, { parentPath: ['A'], titles: ['B'], start: 0, end: content.length });
    expect(trimmed.parentPath).toEqual(['A']);
    expect(trimmed.titles).toEqual(['B']);
  });
});

describe('headingPathLabel', () => {
  it('joins parentPath with " > " and titles with "; ", separated by " > "', () => {
    expect(headingPathLabel({ parentPath: ['Refund Policy'], titles: ['Standard Refund Window'] })).toBe('Refund Policy > Standard Refund Window');
  });

  it('lists every merged title, in order, separated by "; "', () => {
    expect(headingPathLabel({ parentPath: ['Refund Policy'], titles: ['Standard Refund Window', 'Final Sale', 'Damaged Items'] })).toBe(
      'Refund Policy > Standard Refund Window; Final Sale; Damaged Items',
    );
  });

  it('is just the titles, no leading " > ", when parentPath is empty', () => {
    expect(headingPathLabel({ parentPath: [], titles: ['Policy'] })).toBe('Policy');
  });

  it('is just the parent path when titles is empty', () => {
    expect(headingPathLabel({ parentPath: ['A', 'B'], titles: [] })).toBe('A > B');
  });

  it('is the empty string when both are empty', () => {
    expect(headingPathLabel({ parentPath: [], titles: [] })).toBe('');
  });

  it('caps the label at MAX_HEADING_LABEL_LENGTH and truncates with an ellipsis', () => {
    const manyTitles = Array.from({ length: 30 }, (_, i) => `Title Number ${i} With Some Extra Words To Make It Long`);
    const label = headingPathLabel({ parentPath: ['Parent'], titles: manyTitles });
    expect(label.length).toBe(MAX_HEADING_LABEL_LENGTH);
    expect(label.endsWith('...')).toBe(true);
    // Truncating from the end keeps the parent path and the earliest titles intact.
    expect(label.startsWith('Parent > Title Number 0')).toBe(true);
  });

  it('never truncates a label that already fits', () => {
    const label = headingPathLabel({ parentPath: ['A'], titles: ['B'] });
    expect(label.length).toBeLessThan(MAX_HEADING_LABEL_LENGTH);
    expect(label.endsWith('...')).toBe(false);
  });
});

describe('mergeTinySections', () => {
  // "## Tiny" and "## NotTiny" are SIBLINGS (same parent: "Policy"), which is
  // the case mergeTinySections actually handles - a heading and its own
  // child are parent/child, never siblings of each other, so a parent
  // section is never a valid merge target for its own child.
  it('merges a tiny sibling backward into the preceding sibling under the same parent, keeping BOTH titles in order', () => {
    const content =
      '# Policy\n\nRoot intro.\n\n## NotTiny\n\nLong enough content that is not tiny at all, well past the merge threshold here.\n\n## Tiny\n\nx';
    const raw = parseHeadingSections(content);
    const merged = mergeTinySections(content, raw, 10);

    expect(merged.some((s) => headingPathLabel(s) === 'Policy > Tiny')).toBe(false);
    const survivor = merged.find((s) => s.titles.includes('NotTiny'));
    expect(survivor).toBeDefined();
    expect(survivor!.titles).toEqual(['NotTiny', 'Tiny']);
    expect(headingPathLabel(survivor!)).toBe('Policy > NotTiny; Tiny');
    const survivorText = content.slice(survivor!.start, survivor!.end);
    expect(survivorText).toContain('Long enough content');
    expect(survivorText).toContain('x'); // "## Tiny"'s own body, absorbed
  });

  it('merges a tiny leading sibling forward when there is no preceding sibling, titles in document order', () => {
    const content = '# Policy\n\n## Tiny\n\nx\n\n## Long\n\nThis sibling has plenty of content to stay well above the merge threshold here.';
    const raw = parseHeadingSections(content);
    const merged = mergeTinySections(content, raw, 10);

    expect(merged.some((s) => headingPathLabel(s) === 'Policy > Tiny')).toBe(false);
    const survivorForLong = merged.find((s) => s.titles.includes('Long'));
    expect(survivorForLong).toBeDefined();
    // Tiny comes first in the document, so its title is listed first even
    // though it's the one physically absorbed into the later survivor.
    expect(survivorForLong!.titles).toEqual(['Tiny', 'Long']);
    expect(headingPathLabel(survivorForLong!)).toBe('Policy > Tiny; Long');
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
    expect(merged.some((s) => headingPathLabel(s) === 'Policy > OnlyChild')).toBe(true);
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

  it('a long chain of tiny same-parent siblings merges into one section carrying every title, in order', () => {
    // Five tiny siblings under "Policy" (each well under the 50-token
    // floor used here) - all five should end up on ONE surviving section,
    // with all five titles present and in document order.
    const content = [
      '# Policy',
      '',
      '## One',
      '',
      'a',
      '',
      '## Two',
      '',
      'b',
      '',
      '## Three',
      '',
      'c',
      '',
      '## Four',
      '',
      'd',
      '',
      '## Five',
      '',
      'e',
    ].join('\n');
    const raw = parseHeadingSections(content);
    const merged = mergeTinySections(content, raw, 50);

    // Two titled sections survive: the H1's own (now labeled "Policy",
    // after absorbing the empty pre-heading section - a parent, not a
    // sibling of "## One" etc, so it never merges with them) and the one
    // carrying all five "## One".."## Five" children, which IS the chain
    // under test here.
    const chain = merged.find((s) => s.titles.includes('One'));
    expect(chain).toBeDefined();
    expect(chain!.titles).toEqual(['One', 'Two', 'Three', 'Four', 'Five']);
    const text = content.slice(chain!.start, chain!.end);
    expect(text).toContain('a');
    expect(text).toContain('e');
  });

  it('a chain of tiny same-parent siblings can grow past the pack target size, to be split afterward (confirmed with real chunkMarkdown() in markdown-chunker.spec.ts)', () => {
    // Five siblings, each individually tiny (under minMergeTokens) but
    // substantial enough that all five combined comfortably exceed a small
    // target like 40 tokens (~160 chars) - mergeTinySections has no upper
    // bound of its own, by design (see markdown-chunker.spec.ts's test
    // proving packSection is what re-splits an oversized merged section).
    const body = (n: number): string => `Body text for section ${n}, long enough to add real weight to the combined section. `;
    const content = Array.from({ length: 5 }, (_, i) => `## Section${i}\n\n${body(i)}`).join('\n\n');
    const withTitle = `# Policy\n\n${content}`;
    const raw = parseHeadingSections(withTitle);
    const merged = mergeTinySections(withTitle, raw, 30);

    const chain = merged.find((s) => s.titles.includes('Section0'));
    expect(chain).toBeDefined();
    expect(chain!.titles).toEqual(['Section0', 'Section1', 'Section2', 'Section3', 'Section4']);
    const mergedText = withTitle.slice(chain!.start, chain!.end);
    expect(mergedText.length).toBeGreaterThan(160); // well past a 40-token (~160 char) target, confirming no upper bound here
  });
});
