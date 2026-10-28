import { describe, expect, it } from 'vitest';
import { findAtomicZones, packSection } from './section-packer';

describe('findAtomicZones', () => {
  it('finds a fenced code block as one zone', () => {
    const content = 'text\n```js\ncode\nmore code\n```\nmore text';
    const zones = findAtomicZones(content, 0, content.length);
    expect(zones).toHaveLength(1);
    expect(content.slice(zones[0].start, zones[0].end)).toBe('```js\ncode\nmore code\n```\n');
  });

  it('finds a contiguous block of table rows as one zone', () => {
    const content = 'text\n| a | b |\n|---|---|\n| 1 | 2 |\nmore text';
    const zones = findAtomicZones(content, 0, content.length);
    expect(zones).toHaveLength(1);
    expect(content.slice(zones[0].start, zones[0].end)).toBe('| a | b |\n|---|---|\n| 1 | 2 |\n');
  });

  it('finds no zones in plain text', () => {
    expect(findAtomicZones('just plain text, no code or tables', 0, 35)).toEqual([]);
  });
});

describe('packSection', () => {
  it('returns the whole section as one span when it already fits', () => {
    const content = 'short section';
    expect(packSection(content, 0, content.length, 400, 50)).toEqual([[0, content.length]]);
  });

  it('splits an oversized section on paragraph boundaries', () => {
    const paragraph = 'word '.repeat(100); // ~500 chars, one paragraph
    const content = [paragraph, paragraph, paragraph].join('\n\n');
    const spans = packSection(content, 0, content.length, 50, 0); // target 50 tokens = 200 chars, forces a split
    expect(spans.length).toBeGreaterThan(1);
    for (const [start, end] of spans) {
      expect(start).toBeLessThan(end);
      expect(start).toBeGreaterThanOrEqual(0);
      expect(end).toBeLessThanOrEqual(content.length);
    }
  });

  it('never splits inside a fenced code block that is smaller than the chunk size limit', () => {
    const content = 'intro text here\n\n```\ncode\n```\n\nmore text after the fence here';
    const zones = findAtomicZones(content, 0, content.length);
    expect(zones).toHaveLength(1);
    const zone = zones[0];
    expect(zone.end - zone.start).toBeLessThan(40); // the fence fits comfortably inside the budget below

    const spans = packSection(content, 0, content.length, 10, 0); // 10 tokens = 40 chars, forces splitting around (not through) the fence

    const splitInsideZone = spans.some(([, end]) => end > zone.start && end < zone.end);
    expect(splitInsideZone).toBe(false);
  });

  it('hard-splits a fenced code block that alone exceeds the chunk size limit, since there is no other option', () => {
    const hugeCode = 'x'.repeat(500); // one giant unbroken line, no paragraph/sentence breaks anywhere inside
    const content = `intro\n\n\`\`\`\n${hugeCode}\n\`\`\`\n\nouttro`;
    const zones = findAtomicZones(content, 0, content.length);
    expect(zones[0].end - zones[0].start).toBeGreaterThan(400); // bigger than the 10-token/40-char budget below

    const spans = packSection(content, 0, content.length, 10, 0);
    expect(spans.length).toBeGreaterThan(1); // it had to be split somewhere
  });

  it('respects overlap: consecutive spans share overlapping offset ranges', () => {
    const paragraph = 'sentence one. sentence two. sentence three. sentence four. ';
    const content = paragraph.repeat(10);
    const spans = packSection(content, 0, content.length, 20, 10); // 20 tokens=80 chars target, 10 tokens=40 chars overlap
    expect(spans.length).toBeGreaterThan(1);
    let sawOverlap = false;
    for (let i = 0; i + 1 < spans.length; i++) {
      const [, firstEnd] = spans[i];
      const [secondStart] = spans[i + 1];
      // No gap, ever. Strict overlap on every pair isn't guaranteed - the
      // tail end of a section can produce a final span smaller than the
      // overlap window, which caps how far back the next (non-existent,
      // here) span could even start.
      expect(secondStart).toBeLessThanOrEqual(firstEnd);
      if (secondStart < firstEnd) {
        sawOverlap = true;
      }
    }
    expect(sawOverlap).toBe(true);
  });

  it('never splits inside a UTF-16 surrogate pair even under a hard cut', () => {
    const emoji = '😀😁😂🤣😃😄😅😆😉😊'; // 10 astral chars, no spaces, no sentence/paragraph breaks at all
    const content = emoji.repeat(50);
    const spans = packSection(content, 0, content.length, 5, 0); // forces many hard cuts
    for (const [start, end] of spans) {
      const slice = content.slice(start, end);
      // A string built entirely of valid surrogate pairs always has even length
      // in UTF-16 code units when no pair was split; an odd length proves a split pair.
      expect(slice.length % 2).toBe(0);
    }
  });

  it('handles a 1 MB single paragraph (no breaks at all) quickly, with no catastrophic regex backtracking', () => {
    const content = 'a'.repeat(1_000_000);
    const startedAt = Date.now();
    const spans = packSection(content, 0, content.length, 400, 50);
    const elapsedMs = Date.now() - startedAt;

    expect(spans.length).toBeGreaterThan(1);
    expect(elapsedMs).toBeLessThan(2000);
    // Every span is contiguous/covers the content and none are inverted.
    for (const [start, end] of spans) {
      expect(end).toBeGreaterThan(start);
    }
    expect(spans[spans.length - 1][1]).toBe(content.length);
  });
});
