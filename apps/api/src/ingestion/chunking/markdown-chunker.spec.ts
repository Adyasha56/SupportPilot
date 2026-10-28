import { describe, expect, it } from 'vitest';
import { chunkMarkdown } from './markdown-chunker';

function okChunks(text: string, options: Parameters<typeof chunkMarkdown>[1]) {
  const result = chunkMarkdown(text, options);
  if (!result.ok) {
    throw new Error(`Expected ok, got error: ${result.error.code} ${result.error.message}`);
  }
  return result.chunks;
}

describe('chunkMarkdown - input handling', () => {
  it('rejects empty input with a typed error', () => {
    const result = chunkMarkdown('', { documentSlug: 'doc' });
    expect(result).toEqual({ ok: false, error: { code: 'EMPTY_INPUT', message: expect.any(String) } });
  });

  it('rejects whitespace-only input with a typed error', () => {
    const result = chunkMarkdown('   \n\n\t  ', { documentSlug: 'doc' });
    expect(result.ok).toBe(false);
  });

  it('rejects a document that is only front matter', () => {
    const result = chunkMarkdown('---\ntitle: X\n---\n', { documentSlug: 'doc' });
    expect(result.ok).toBe(false);
  });

  it('normalizes CRLF before chunking - identical output for CRLF and LF versions of the same document', () => {
    const lf = '# Heading\n\nSome body text here that is reasonably sized for a single chunk.';
    const crlf = lf.replace(/\n/g, '\r\n');
    const lfChunks = okChunks(lf, { documentSlug: 'doc' });
    const crlfChunks = okChunks(crlf, { documentSlug: 'doc' });
    expect(crlfChunks.map((c) => c.text)).toEqual(lfChunks.map((c) => c.text));
    expect(crlfChunks.map((c) => c.headingPath)).toEqual(lfChunks.map((c) => c.headingPath));
  });

  it('strips front matter and never embeds it', () => {
    const text = '---\ntitle: Refund Policy\n---\n# Refund Policy\n\nRefunds within 30 days.';
    const chunks = okChunks(text, { documentSlug: 'doc' });
    for (const chunk of chunks) {
      expect(chunk.text).not.toContain('title: Refund Policy');
      expect(chunk.embeddingText).not.toContain('title: Refund Policy');
    }
  });

  it('exceeding maxChunks is a typed error, not a silent truncation', () => {
    // minMergeTokens: 1 so each heading's short body stays its own section
    // rather than cascading together via the default merge threshold.
    const headings = Array.from(
      { length: 20 },
      (_, i) => `# Heading ${i}\n\nSome unique body text for heading number ${i}, distinct from all its siblings here.`,
    ).join('\n\n');
    const result = chunkMarkdown(headings, { documentSlug: 'doc', maxChunks: 3, minMergeTokens: 1 });
    expect(result).toMatchObject({ ok: false, error: { code: 'TOO_MANY_CHUNKS' } });
  });
});

describe('chunkMarkdown - headings', () => {
  it('a document with no headings produces one top-level chunk', () => {
    const text = 'Just a plain paragraph of text with no headings anywhere in it at all.';
    const chunks = okChunks(text, { documentSlug: 'doc' });
    expect(chunks).toHaveLength(1);
    expect(chunks[0].headingPath).toBe('');
    expect(chunks[0].text).toBe(text);
  });

  it('builds a readable heading path like "Refund Policy > Late Delivery"', () => {
    const text =
      '# Refund Policy\n\nIntro text that is long enough to not be merged away into a neighbor under the same parent heading.\n\n## Late Delivery\n\nIf your order is late, contact support for a refund within the stated window of time.';
    const chunks = okChunks(text, { documentSlug: 'doc', minMergeTokens: 1 });
    expect(chunks.some((c) => c.headingPath === 'Refund Policy > Late Delivery')).toBe(true);
  });

  it('a heading-only document (no body text anywhere) does not crash and returns something', () => {
    const text = '# A\n## B\n### C';
    const result = chunkMarkdown(text, { documentSlug: 'doc' });
    expect(result.ok).toBe(true);
  });

  it('duplicate heading titles at the same level are kept as distinct chunks', () => {
    const text =
      '# Policy\n\nIntro text long enough to stand on its own without being merged into either Notes section below here.\n\n## Notes\n\nFirst notes section with enough unique content to stay separate from the second one below.\n\n## Notes\n\nSecond notes section, also with enough unique content of its own to remain a distinct chunk.';
    const chunks = okChunks(text, { documentSlug: 'doc', minMergeTokens: 1 });
    const notesChunks = chunks.filter((c) => c.headingPath === 'Policy > Notes');
    expect(notesChunks.length).toBe(2);
    expect(notesChunks[0].text).not.toBe(notesChunks[1].text);
  });

  it('a "#" line inside a fenced code block is not treated as a heading', () => {
    const text = '# Real Heading\n\nSome intro text.\n\n```\n# not a heading\n```\n\nMore text after the fence.';
    const chunks = okChunks(text, { documentSlug: 'doc' });
    expect(chunks.every((c) => c.headingPath === 'Real Heading' || c.headingPath === '')).toBe(true);
    expect(chunks.some((c) => c.text.includes('# not a heading'))).toBe(true);
  });
});

describe('chunkMarkdown - unicode', () => {
  it('handles emoji and CJK text without corrupting characters', () => {
    const text = '# 標題\n\n這是一個測試文件，包含中文字符和表情符號 😀🎉👍。這段文字應該足夠長，可以形成一個完整的區塊。';
    const chunks = okChunks(text, { documentSlug: 'doc' });
    expect(chunks.length).toBeGreaterThan(0);
    const joined = chunks.map((c) => c.text).join('');
    expect(joined).toContain('😀🎉👍');
    expect(joined).toContain('標題'.length ? '這是一個測試文件' : '');
  });
});

describe('chunkMarkdown - embeddingText design', () => {
  it('embeddingText is headingPath + blank line + text when there is a heading', () => {
    const text =
      '# Refund Policy\n\nIntro long enough on its own to avoid being merged into the subsection below this point here.\n\n## Timing\n\nRefunds are issued within 30 days of the original purchase date, no exceptions apply.';
    const chunks = okChunks(text, { documentSlug: 'doc', minMergeTokens: 1 });
    const timing = chunks.find((c) => c.headingPath === 'Refund Policy > Timing');
    expect(timing).toBeDefined();
    expect(timing!.embeddingText).toBe(`${timing!.headingPath}\n\n${timing!.text}`);
  });

  it('embeddingText equals text when there is no heading path', () => {
    const text = 'No heading at all, just a paragraph of plain body text here.';
    const chunks = okChunks(text, { documentSlug: 'doc' });
    expect(chunks[0].headingPath).toBe('');
    expect(chunks[0].embeddingText).toBe(chunks[0].text);
  });
});

describe('chunkMarkdown - offsets', () => {
  it('every chunk\'s offsets slice back to exactly its own text, against the normalized content', () => {
    const raw = '---\ntitle: X\n---\n# Heading\r\n\r\nSome body text that is reasonably sized for one chunk here.';
    const normalized = raw.replace(/\r\n/g, '\n').replace(/^---\n[\s\S]*?\n---\n/, '');
    const chunks = okChunks(raw, { documentSlug: 'doc' });
    for (const chunk of chunks) {
      expect(normalized.slice(chunk.startOffset, chunk.endOffset)).toBe(chunk.text);
    }
  });

  it('chunk positions and chunkKeys are stable and sequential', () => {
    const text = '# A\n\nSome text for section A that is long enough to stand alone as its own chunk here.\n\n# B\n\nSome text for section B that is long enough to stand alone as its own chunk here too.';
    const chunks = okChunks(text, { documentSlug: 'my-doc' });
    chunks.forEach((chunk, i) => {
      expect(chunk.position).toBe(i);
      expect(chunk.chunkKey).toBe(`my-doc-${i}`);
    });
  });
});

describe('chunkMarkdown - determinism', () => {
  it('chunking the same input twice produces identical output', () => {
    const text =
      '# Policy\n\nSome intro content here.\n\n## Section A\n\nSection A body text, long enough to be its own chunk comfortably.\n\n## Section B\n\nSection B body text, also long enough to be its own distinct chunk.';
    const first = okChunks(text, { documentSlug: 'doc' });
    const second = okChunks(text, { documentSlug: 'doc' });
    expect(first).toEqual(second);
  });
});

describe('chunkMarkdown - overlap', () => {
  it('splits a long single section into overlapping chunks that target the configured token range', () => {
    const paragraphs = Array.from({ length: 30 }, (_, i) => `This is paragraph number ${i} with a modest amount of filler text in it.`);
    const text = `# Long Section\n\n${paragraphs.join('\n\n')}`;
    const chunks = okChunks(text, { documentSlug: 'doc', targetTokens: 100, overlapTokens: 20 });
    expect(chunks.length).toBeGreaterThan(1);
    let sawOverlap = false;
    for (let i = 0; i + 1 < chunks.length; i++) {
      if (chunks[i].headingPath === chunks[i + 1].headingPath) {
        // No gap between consecutive chunks from the same section - the
        // last pair near the end of a section can legitimately have zero
        // overlap if what's left is smaller than the overlap window, so
        // this only requires "no gap", not "always strictly overlapping".
        expect(chunks[i + 1].startOffset).toBeLessThanOrEqual(chunks[i].endOffset);
        if (chunks[i + 1].startOffset < chunks[i].endOffset) {
          sawOverlap = true;
        }
      }
    }
    expect(sawOverlap).toBe(true);
  });
});

describe('chunkMarkdown - large input performance', () => {
  it('chunks a 1 MB single paragraph within a time bound', () => {
    const text = `# Big\n\n${'word '.repeat(220_000)}`; // ~1.1MB, one giant paragraph, no breaks
    const startedAt = Date.now();
    const result = chunkMarkdown(text, { documentSlug: 'doc', maxChunks: 100_000 });
    const elapsedMs = Date.now() - startedAt;

    expect(result.ok).toBe(true);
    expect(elapsedMs).toBeLessThan(5000);
  });
});
