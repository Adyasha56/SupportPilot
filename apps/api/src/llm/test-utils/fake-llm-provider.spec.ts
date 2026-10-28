import { describe, expect, it } from 'vitest';
import { FakeLlmProvider } from './fake-llm-provider';

function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
  }
  return dot; // both inputs are already L2-normalized, so the dot product IS the cosine similarity
}

describe('FakeLlmProvider', () => {
  it('is deterministic - the same text always embeds to the same vector', async () => {
    const provider = new FakeLlmProvider();
    const first = await provider.embed(['the order has not arrived'], 'RETRIEVAL_DOCUMENT');
    const second = await provider.embed(['the order has not arrived'], 'RETRIEVAL_DOCUMENT');

    expect(first.ok && second.ok).toBe(true);
    if (first.ok && second.ok) {
      expect(first.result.vectors[0].values).toEqual(second.result.vectors[0].values);
    }
  });

  it('returns one L2-normalized vector per input text, in order', async () => {
    const provider = new FakeLlmProvider();
    const result = await provider.embed(['alpha', 'beta'], 'RETRIEVAL_DOCUMENT');

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.result.vectors.map((v) => v.text)).toEqual(['alpha', 'beta']);
      for (const vector of result.result.vectors) {
        const norm = Math.sqrt(vector.values.reduce((sum, v) => sum + v * v, 0));
        expect(norm).toBeCloseTo(1);
      }
    }
  });

  /**
   * This is the one property the fake is built to demonstrate, and the one
   * property its tests should rely on: texts that share words land closer
   * together (by cosine similarity) than texts that share none. It proves
   * nothing about REAL semantic retrieval quality - no synonyms ("refund"
   * vs "money back"), no paraphrase, no word order, no cross-lingual
   * matching, nothing a real embedding model would actually be good at.
   * It exists so other modules' tests can assert "the more relevant chunk
   * was retrieved" without a real API call, not to predict real recall.
   */
  it('scores texts that share words as more similar than texts that share none', async () => {
    const provider = new FakeLlmProvider();
    const result = await provider.embed(
      ['my order has not arrived yet', 'the order has still not arrived', 'the weather today is sunny and warm'],
      'RETRIEVAL_DOCUMENT',
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const [related1, related2, unrelated] = result.result.vectors.map((v) => v.values);
    const relatedSimilarity = cosineSimilarity(related1, related2);
    const crossSimilarity1 = cosineSimilarity(related1, unrelated);
    const crossSimilarity2 = cosineSimilarity(related2, unrelated);

    expect(relatedSimilarity).toBeGreaterThan(crossSimilarity1);
    expect(relatedSimilarity).toBeGreaterThan(crossSimilarity2);
  });
});
