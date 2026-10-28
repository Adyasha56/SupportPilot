import { describe, expect, it } from 'vitest';
import { EmbeddingLruCache } from './embedding-cache';

describe('EmbeddingLruCache', () => {
  it('returns undefined for a key that was never set', () => {
    const cache = new EmbeddingLruCache(10);
    expect(cache.get('missing')).toBeUndefined();
  });

  it('round-trips a stored value', () => {
    const cache = new EmbeddingLruCache(10);
    cache.set('a', [1, 2, 3]);
    expect(cache.get('a')).toEqual([1, 2, 3]);
  });

  it('evicts the least-recently-used entry once at capacity', () => {
    const cache = new EmbeddingLruCache(2);
    cache.set('a', [1]);
    cache.set('b', [2]);
    cache.set('c', [3]); // evicts 'a' (oldest, never re-touched)

    expect(cache.get('a')).toBeUndefined();
    expect(cache.get('b')).toEqual([2]);
    expect(cache.get('c')).toEqual([3]);
    expect(cache.size).toBe(2);
  });

  it('a get() refreshes recency, protecting it from the next eviction', () => {
    const cache = new EmbeddingLruCache(2);
    cache.set('a', [1]);
    cache.set('b', [2]);
    cache.get('a'); // 'a' is now more recently used than 'b'
    cache.set('c', [3]); // evicts 'b', not 'a'

    expect(cache.get('a')).toEqual([1]);
    expect(cache.get('b')).toBeUndefined();
    expect(cache.get('c')).toEqual([3]);
  });

  describe('key', () => {
    it('produces different keys for different models, dimensions, task types, or texts', () => {
      const base = EmbeddingLruCache.key('model-a', 768, 'RETRIEVAL_DOCUMENT', 'hello');
      expect(EmbeddingLruCache.key('model-b', 768, 'RETRIEVAL_DOCUMENT', 'hello')).not.toBe(base);
      expect(EmbeddingLruCache.key('model-a', 1536, 'RETRIEVAL_DOCUMENT', 'hello')).not.toBe(base);
      expect(EmbeddingLruCache.key('model-a', 768, 'RETRIEVAL_QUERY', 'hello')).not.toBe(base);
      expect(EmbeddingLruCache.key('model-a', 768, 'RETRIEVAL_DOCUMENT', 'goodbye')).not.toBe(base);
    });

    it('is deterministic for the same inputs', () => {
      const first = EmbeddingLruCache.key('model-a', 768, 'RETRIEVAL_DOCUMENT', 'hello');
      const second = EmbeddingLruCache.key('model-a', 768, 'RETRIEVAL_DOCUMENT', 'hello');
      expect(first).toBe(second);
    });
  });
});
