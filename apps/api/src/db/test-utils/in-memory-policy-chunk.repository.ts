import { randomUUID } from 'node:crypto';
import {
  NewPolicyChunk,
  PolicyChunkRepository,
  VectorSearchParams,
  VectorSearchResultItem,
} from '../policy-chunk.repository';

interface StoredChunk extends NewPolicyChunk {
  id: string;
  active: boolean;
}

function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) {
    return 0;
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/**
 * Brute-force cosine similarity over everything matching the tenantId+active
 * pre-filter - mirrors $vectorSearch's pre-filter semantics (filter first,
 * then rank), always "exact" since fixture data is always small in tests.
 */
export class InMemoryPolicyChunkRepository implements PolicyChunkRepository {
  private readonly chunks: StoredChunk[] = [];

  async insertMany(chunks: NewPolicyChunk[]): Promise<void> {
    for (const chunk of chunks) {
      this.chunks.push({ ...chunk, id: randomUUID(), active: true });
    }
  }

  async deactivateForDocument(tenantId: string, documentId: string): Promise<void> {
    for (const chunk of this.chunks) {
      if (chunk.tenantId === tenantId && chunk.documentId === documentId) {
        chunk.active = false;
      }
    }
  }

  async deleteForDocument(tenantId: string, documentId: string): Promise<void> {
    this.removeWhere((chunk) => chunk.tenantId === tenantId && chunk.documentId === documentId);
  }

  async deleteInactiveForDocument(tenantId: string, documentId: string): Promise<void> {
    this.removeWhere((chunk) => chunk.tenantId === tenantId && chunk.documentId === documentId && !chunk.active);
  }

  async deleteForTenant(tenantId: string): Promise<void> {
    this.removeWhere((chunk) => chunk.tenantId === tenantId);
  }

  async countForTenant(tenantId: string): Promise<number> {
    return this.chunks.filter((chunk) => chunk.tenantId === tenantId).length;
  }

  async vectorSearch(params: VectorSearchParams): Promise<VectorSearchResultItem[]> {
    const { tenantId, queryVector, limit } = params;
    return this.chunks
      .filter((chunk) => chunk.tenantId === tenantId && chunk.active)
      .map((chunk) => ({
        chunkId: chunk.id,
        documentId: chunk.documentId,
        title: chunk.title,
        text: chunk.text,
        score: cosineSimilarity(chunk.embedding, queryVector),
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }

  private removeWhere(predicate: (chunk: StoredChunk) => boolean): void {
    for (let i = this.chunks.length - 1; i >= 0; i--) {
      if (predicate(this.chunks[i])) {
        this.chunks.splice(i, 1);
      }
    }
  }
}
