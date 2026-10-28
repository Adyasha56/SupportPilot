import { createHash } from 'node:crypto';

/**
 * Bounded in-process LRU, no database involved - per RULES.md section 7
 * ("cache LLM and embedding results... where it is safe to do so") and the
 * explicit decision to keep this cache ephemeral and process-local, not a
 * persisted store. The key includes model, dimension, and task type (not
 * just the text) because the same text embeds to a DIFFERENT vector under
 * each of those - reusing a RETRIEVAL_DOCUMENT vector for a RETRIEVAL_QUERY
 * lookup, or a 768-dim vector where a 1536-dim one was asked for, would be
 * a silent correctness bug, not a cache hit.
 */
export class EmbeddingLruCache {
  private readonly store = new Map<string, number[]>();

  constructor(private readonly maxEntries: number) {}

  static key(model: string, dimension: number, taskType: string, text: string): string {
    const textHash = createHash('sha256').update(text, 'utf8').digest('hex');
    return `${model}:${dimension}:${taskType}:${textHash}`;
  }

  get(key: string): number[] | undefined {
    const value = this.store.get(key);
    if (value === undefined) {
      return undefined;
    }
    // Re-insert to move this key to the end (most-recently-used) - Map
    // iteration/eviction order follows insertion order, so this is what
    // makes eviction below an LRU policy rather than a plain FIFO one.
    this.store.delete(key);
    this.store.set(key, value);
    return value;
  }

  set(key: string, value: number[]): void {
    if (this.store.has(key)) {
      this.store.delete(key);
    } else if (this.store.size >= this.maxEntries) {
      const oldestKey = this.store.keys().next().value;
      if (oldestKey !== undefined) {
        this.store.delete(oldestKey);
      }
    }
    this.store.set(key, value);
  }

  get size(): number {
    return this.store.size;
  }
}
