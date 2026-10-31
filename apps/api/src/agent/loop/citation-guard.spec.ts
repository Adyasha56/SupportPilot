import { RetrievalResult } from '@supportpilot/shared';
import { describe, expect, it } from 'vitest';
import { guardCitations } from './citation-guard';

function makeResult(overrides: Partial<RetrievalResult> = {}): RetrievalResult {
  return {
    chunkKey: 'doc1-0',
    documentId: 'doc1',
    documentTitle: 'Refund Policy',
    headingPath: 'Refunds',
    text: 'irrelevant',
    position: 0,
    score: 0.9,
    ...overrides,
  };
}

describe('guardCitations', () => {
  it('keeps a chunkKey that was actually retrieved, enriched with its real title/headingPath', () => {
    const result = guardCitations(['doc1-0'], [makeResult()], 5);
    expect(result).toEqual({ citations: [{ chunkKey: 'doc1-0', documentTitle: 'Refund Policy', headingPath: 'Refunds' }], droppedCount: 0 });
  });

  it('drops a chunkKey the model claimed but was never actually retrieved this turn', () => {
    const result = guardCitations(['doc1-0', 'never-retrieved'], [makeResult()], 5);
    expect(result.citations).toEqual([{ chunkKey: 'doc1-0', documentTitle: 'Refund Policy', headingPath: 'Refunds' }]);
    expect(result.droppedCount).toBe(1);
  });

  it('dedupes a repeated chunkKey, counting the repeat as dropped', () => {
    const result = guardCitations(['doc1-0', 'doc1-0'], [makeResult()], 5);
    expect(result.citations).toHaveLength(1);
    expect(result.droppedCount).toBe(1);
  });

  it('caps the citation count at maxCitations, counting the overflow as dropped', () => {
    const retrieved = [
      makeResult({ chunkKey: 'a' }),
      makeResult({ chunkKey: 'b' }),
      makeResult({ chunkKey: 'c' }),
    ];
    const result = guardCitations(['a', 'b', 'c'], retrieved, 2);
    expect(result.citations.map((c) => c.chunkKey)).toEqual(['a', 'b']);
    expect(result.droppedCount).toBe(1);
  });

  it('returns no citations and droppedCount 0 for an empty cited list', () => {
    const result = guardCitations([], [makeResult()], 5);
    expect(result).toEqual({ citations: [], droppedCount: 0 });
  });

  it('never trusts a title/headingPath the model might have embedded in the key - always uses the retrieval result\'s own fields', () => {
    const retrieved = [makeResult({ chunkKey: 'doc1-0', documentTitle: 'Real Title', headingPath: 'Real > Path' })];
    const result = guardCitations(['doc1-0'], retrieved, 5);
    expect(result.citations[0]).toEqual({ chunkKey: 'doc1-0', documentTitle: 'Real Title', headingPath: 'Real > Path' });
  });
});
