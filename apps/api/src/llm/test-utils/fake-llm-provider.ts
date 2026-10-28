import { createHash } from 'node:crypto';
import { EMBEDDING_DIMENSION } from '@supportpilot/shared';
import { EmbedOutcome, EmbeddingTaskType, LlmProvider } from '../llm-provider.interface';

/**
 * Deterministic feature-hashing ("hashing trick") bag-of-words embedder:
 * each word is hashed to one of EMBEDDING_DIMENSION buckets with a
 * deterministic +1/-1 sign, the per-word contributions are summed, and the
 * result is L2-normalized. No real model, no randomness, no network call -
 * for tests only, never for real eval numbers (see its test file for what
 * this does and does not prove).
 */
function hashEmbed(text: string, dimension: number): number[] {
  const vector = new Array(dimension).fill(0);
  const words = text.toLowerCase().match(/[a-z0-9]+/g) ?? [];

  for (const word of words) {
    const digest = createHash('sha256').update(word, 'utf8').digest();
    const index = digest.readUInt32BE(0) % dimension;
    const sign = digest[4] % 2 === 0 ? 1 : -1;
    vector[index] += sign;
  }

  const norm = Math.sqrt(vector.reduce((sum, v) => sum + v * v, 0));
  return norm === 0 ? vector : vector.map((v) => v / norm);
}

export class FakeLlmProvider implements LlmProvider {
  async embed(texts: string[], _taskType: EmbeddingTaskType): Promise<EmbedOutcome> {
    return {
      ok: true,
      result: {
        vectors: texts.map((text) => ({ text, values: hashEmbed(text, EMBEDDING_DIMENSION) })),
        model: 'fake-hashing-embedder',
        dimension: EMBEDDING_DIMENSION,
      },
    };
  }
}
