import { describe, expect, it } from 'vitest';
import { RetrievalResultSchema } from './retrieval.schema';

describe('RetrievalResultSchema', () => {
  it('accepts a valid result', () => {
    const result = RetrievalResultSchema.safeParse({
      chunkKey: 'd1-0',
      documentId: 'd1',
      documentTitle: 'Refund Policy',
      headingPath: 'Refund Policy > Late Delivery',
      text: 'Refunds within 30 days.',
      position: 0,
      score: 0.83,
    });
    expect(result.success).toBe(true);
  });

  it('rejects a negative position', () => {
    const result = RetrievalResultSchema.safeParse({
      chunkKey: 'd1-0',
      documentId: 'd1',
      documentTitle: 'x',
      headingPath: '',
      text: 'x',
      position: -1,
      score: 0.5,
    });
    expect(result.success).toBe(false);
  });

  it('has no field for the embedding vector', () => {
    expect(Object.keys(RetrievalResultSchema.shape)).not.toContain('embedding');
  });
});
