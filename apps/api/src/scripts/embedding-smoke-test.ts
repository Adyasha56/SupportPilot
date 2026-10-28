/**
 * Manual only - calls the REAL Gemini API and spends real free-tier quota.
 * Never run in CI, never run automatically. Run it yourself:
 *
 *   pnpm run embedding-smoke-test
 *
 * Embeds two related sentences and one unrelated one, and prints only the
 * vector length, each vector's L2 norm, and the three pairwise cosine
 * similarities - never the raw key, never a full vector, matching RULES.md
 * section 5's rule against logging secrets.
 *
 * Compiled to dist/scripts and run as plain JS, same reasoning as every
 * other script here (decorators/constructor parameter properties aren't
 * supported by Node's native TypeScript type stripping).
 */
import { EMBEDDING_DIMENSION, EMBEDDING_MODEL } from '@supportpilot/shared';
import { GeminiLlmProvider } from '../llm/gemini-llm-provider';
import { loadLlmSettingsFromEnv } from '../llm/llm.settings';
import { EmbeddingFileCache } from './embedding-file-cache';

const SENTENCES = [
  'My order has not arrived yet.',
  'I have not received my package.',
  'The weather today is sunny and warm.',
] as const;
const TASK_TYPE = 'RETRIEVAL_DOCUMENT';

function l2Norm(values: number[]): number {
  return Math.sqrt(values.reduce((sum, v) => sum + v * v, 0));
}

function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
  }
  return dot;
}

function cacheKey(text: string): string {
  return `${EMBEDDING_MODEL}:${EMBEDDING_DIMENSION}:${TASK_TYPE}:${text}`;
}

async function main(): Promise<void> {
  const settings = loadLlmSettingsFromEnv(process.env);
  if (!settings.geminiApiKey) {
    console.error('GEMINI_API_KEY is not set.');
    process.exitCode = 1;
    return;
  }

  const fileCacheDir = process.env.GEMINI_EMBED_FILE_CACHE_DIR;
  const fileCache = fileCacheDir ? new EmbeddingFileCache(fileCacheDir) : undefined;

  const provider = new GeminiLlmProvider(settings);

  const vectors: number[][] = [];
  const toFetch: string[] = [];
  const toFetchIndexes: number[] = [];

  for (let i = 0; i < SENTENCES.length; i++) {
    const cached = fileCache?.get(cacheKey(SENTENCES[i]));
    if (cached) {
      vectors[i] = cached;
    } else {
      toFetch.push(SENTENCES[i]);
      toFetchIndexes.push(i);
    }
  }

  if (toFetch.length > 0) {
    const result = await provider.embed(toFetch, TASK_TYPE);
    if (!result.ok) {
      console.error(`embedding-smoke-test failed: [${result.error.code}] ${result.error.message}`);
      process.exitCode = 1;
      return;
    }
    for (let j = 0; j < toFetchIndexes.length; j++) {
      const index = toFetchIndexes[j];
      vectors[index] = result.result.vectors[j].values;
      fileCache?.set(cacheKey(SENTENCES[index]), vectors[index]);
    }
  }

  const [related1, related2, unrelated] = vectors;

  console.log(`Vector length: ${related1.length}`);
  console.log(`L2 norms: ${vectors.map((v) => l2Norm(v).toFixed(4)).join(', ')}`);
  console.log(`Cosine similarity (related sentence 1 vs related sentence 2): ${cosineSimilarity(related1, related2).toFixed(4)}`);
  console.log(`Cosine similarity (related sentence 1 vs unrelated sentence): ${cosineSimilarity(related1, unrelated).toFixed(4)}`);
  console.log(`Cosine similarity (related sentence 2 vs unrelated sentence): ${cosineSimilarity(related2, unrelated).toFixed(4)}`);
}

main().catch((err: unknown) => {
  console.error('embedding-smoke-test failed:', err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
