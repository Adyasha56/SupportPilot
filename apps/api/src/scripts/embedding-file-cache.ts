/**
 * For embedding-smoke-test.ts ONLY - never imported by any app module, and
 * never by db:ensure-indexes or create-api-key. Persists embeddings across
 * separate runs of the smoke script (a fresh process each time, so the
 * provider's own in-memory LRU cache never helps), to avoid burning Gemini
 * free-tier quota on the same three fixed sentences every run.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

/**
 * The directory comes from an operator-set env var, not request input, so
 * the traversal risk is low - this still rejects an empty value and
 * resolves to an absolute path before any filesystem call, rather than
 * trusting the string as-is.
 */
export function resolveCacheDir(dir: string): string {
  if (dir.trim().length === 0) {
    throw new Error('GEMINI_EMBED_FILE_CACHE_DIR must not be empty.');
  }
  return resolve(dir);
}

export class EmbeddingFileCache {
  private readonly dir: string;

  constructor(dir: string) {
    this.dir = resolveCacheDir(dir);
    mkdirSync(this.dir, { recursive: true });
  }

  private fileFor(key: string): string {
    // The cache key is already a hash-derived string; re-hashed here only
    // so it's a safe, fixed-shape filename, never a path built from it directly.
    const safeName = `${createHash('sha256').update(key, 'utf8').digest('hex')}.json`;
    return join(this.dir, safeName);
  }

  get(key: string): number[] | undefined {
    const file = this.fileFor(key);
    if (!existsSync(file)) {
      return undefined;
    }
    return JSON.parse(readFileSync(file, 'utf8')) as number[];
  }

  set(key: string, values: number[]): void {
    writeFileSync(this.fileFor(key), JSON.stringify(values));
  }
}
