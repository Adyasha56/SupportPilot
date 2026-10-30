/**
 * Milestone 2, Stage 8 - retrieval quality against the REAL Gemini embedder
 * (never FakeLlmProvider). Manual only - calls the real Gemini API and
 * spends real free-tier quota on cache misses. Never run in CI, never run
 * automatically:
 *
 *   pnpm run retrieval-quality-check
 *   pnpm run retrieval-quality-check -- --allow-test-db
 *
 * What it does: creates one scratch tenant, ingests evals/retrieval-fixtures/
 * sample-policy.md through the REAL PolicyIngestionService (real chunker,
 * real commit path, real Mongo repositories, real Atlas Vector Search),
 * waits until searchable, runs every question in
 * evals/retrieval-fixtures/questions.json through the REAL
 * PolicyRetrievalService.retrieve() with topK 5, prints recall@1/3/5 and
 * MRR (overall and by tag), a side-by-side comparison against an
 * in-memory-only experiment that embeds plain chunk text instead of
 * production's headingPath-prefixed text (see runPlainTextExperiment()
 * below - this never touches Atlas or production code, it only computes
 * cosine similarity locally against the same real Gemini vectors), and a
 * failure diagnosis for every question whose expected chunk didn't make
 * top-5. Deletes everything it created, by tenant id, in a `finally` block.
 *
 * Caching: every embed() call (ingestion AND retrieval AND the experiment)
 * goes through CachingLlmProvider, a thin wrapper around the real
 * GeminiLlmProvider backed by EmbeddingFileCache (the same gitignored
 * file cache embedding-smoke-test.ts uses, GEMINI_EMBED_FILE_CACHE_DIR -
 * defaults to ./.embedding-cache if unset, since this script's whole point
 * is "reruns spend no quota", unlike the smoke test where file caching is
 * optional). Real network calls (cache misses) still go through the real,
 * throttled GeminiLlmProvider, which enforces GEMINI_EMBED_RPM itself - no
 * separate throttling needed here.
 *
 * Privacy: never prints the policy's or a chunk's actual text, anywhere -
 * only headingPath labels, positions, counts, ranks, and scores. Questions
 * (authored for this fixture, not policy content) are printed since the
 * report is meaningless without them.
 *
 * Compiled to dist/scripts and run as plain JS, same reasoning as every
 * other script here (decorators/constructor parameter properties aren't
 * supported by Node's native TypeScript stripping) - none of the classes
 * this script constructs go through Nest's DI container.
 */
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import mongoose from 'mongoose';
import { EMBEDDING_DIMENSION, EMBEDDING_MODEL } from '@supportpilot/shared';
import { assertNotTestDatabase, getDatabaseNameFromUri } from '../db/database-name';
import { MongoosePolicyChunkRepository, PolicyChunkRepository } from '../db/policy-chunk.repository';
import { MongoosePolicyDocumentRepository, PolicyDocumentRepository } from '../db/policy-document.repository';
import { MongooseTransactionRunner } from '../db/transaction-runner';
import { ApiKeySchema } from '../db/schemas/api-key.schema';
import { PolicyChunkDocument, PolicyChunkSchema } from '../db/schemas/policy-chunk.schema';
import { PolicyDocumentDocument, PolicyDocumentSchema } from '../db/schemas/policy-document.schema';
import { TenantSchema } from '../db/schemas/tenant.schema';
import { chunkMarkdown } from '../ingestion/chunking/markdown-chunker';
import { Chunk } from '../ingestion/chunking/markdown-chunker.types';
import { PolicyIngestionService } from '../ingestion/policy-ingestion.service';
import { TenantIngestionLock } from '../ingestion/tenant-ingestion-lock';
import { GeminiLlmProvider } from '../llm/gemini-llm-provider';
import { EmbedOutcome, EmbeddingTaskType, LlmProvider } from '../llm/llm-provider.interface';
import { loadLlmSettingsFromEnv } from '../llm/llm.settings';
import { PolicyRetrievalService } from '../retrieval/policy-retrieval.service';
import { EmbeddingFileCache } from './embedding-file-cache';

const POLL_INTERVAL_MS = 2000;
const POLL_TIMEOUT_MS = 60_000;
const TOP_K = 5;
const DEFAULT_CACHE_DIR = '.embedding-cache';

interface ExpectedChunk {
  headingPath: string;
  position: number;
}

interface Question {
  id: string;
  tag: string;
  question: string;
  expectedChunks: ExpectedChunk[];
}

interface FixturesFile {
  questions: Question[];
}

/**
 * Wraps a real LlmProvider with the file cache, so repeated runs of this
 * script (and the ingestion + retrieval + experiment embed() calls within
 * ONE run) never re-embed the same text twice. Handles a batch with a
 * partial cache hit correctly - only the misses go to the real provider.
 */
class CachingLlmProvider implements LlmProvider {
  public realCalls = 0;
  public cacheHits = 0;

  constructor(
    private readonly inner: LlmProvider,
    private readonly cache: EmbeddingFileCache,
  ) {}

  private key(text: string, taskType: EmbeddingTaskType): string {
    return `${EMBEDDING_MODEL}:${EMBEDDING_DIMENSION}:${taskType}:${text}`;
  }

  async embed(texts: string[], taskType: EmbeddingTaskType): Promise<EmbedOutcome> {
    const values: (number[] | undefined)[] = texts.map((t) => this.cache.get(this.key(t, taskType)));
    const missIndexes = values.reduce<number[]>((acc, v, i) => (v === undefined ? [...acc, i] : acc), []);
    this.cacheHits += texts.length - missIndexes.length;

    if (missIndexes.length > 0) {
      this.realCalls += 1;
      const result = await this.inner.embed(
        missIndexes.map((i) => texts[i]),
        taskType,
      );
      if (!result.ok) {
        return result;
      }
      for (let j = 0; j < missIndexes.length; j++) {
        const idx = missIndexes[j];
        values[idx] = result.result.vectors[j].values;
        this.cache.set(this.key(texts[idx], taskType), values[idx]!);
      }
    }

    return {
      ok: true,
      result: {
        vectors: texts.map((t, i) => ({ text: t, values: values[i]! })),
        model: EMBEDDING_MODEL,
        dimension: EMBEDDING_DIMENSION,
      },
    };
  }
}

function randomScratchTenantId(): string {
  return `rq-${randomBytes(4).toString('hex')}`;
}

function log(message: string): void {
  console.log(message);
}

async function pollUntilSearchable(retrieval: PolicyRetrievalService, tenantId: string, query: string, expectedDocumentId: string): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < POLL_TIMEOUT_MS) {
    const result = await retrieval.retrieve(tenantId, query, { topK: TOP_K });
    if (result.ok && result.results.some((r) => r.documentId === expectedDocumentId)) {
      log(`Document became searchable after ${((Date.now() - startedAt) / 1000).toFixed(1)}s.`);
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
  throw new Error(`Timed out after ${POLL_TIMEOUT_MS / 1000}s waiting for the ingested document to become searchable.`);
}

interface RankedHit {
  headingPath: string;
  position: number;
  score: number;
}

/** 1-indexed rank of the first hit matching any of the expected chunks, or undefined if none of the returned hits match. */
function rankOfExpected(hits: RankedHit[], expected: ExpectedChunk[]): number | undefined {
  for (let i = 0; i < hits.length; i++) {
    if (expected.some((e) => e.headingPath === hits[i].headingPath && e.position === hits[i].position)) {
      return i + 1;
    }
  }
  return undefined;
}

interface QuestionRunResult {
  question: Question;
  hits: RankedHit[];
  rank: number | undefined;
}

interface TagMetrics {
  tag: string;
  count: number;
  recallAt1: number;
  recallAt3: number;
  recallAt5: number;
  mrr: number;
}

function computeMetrics(results: QuestionRunResult[], tagFilter?: string): Omit<TagMetrics, 'tag'> {
  const subset = tagFilter ? results.filter((r) => r.question.tag === tagFilter) : results;
  const count = subset.length;
  if (count === 0) {
    return { count: 0, recallAt1: 0, recallAt3: 0, recallAt5: 0, mrr: 0 };
  }
  const hitsAt = (k: number): number => subset.filter((r) => r.rank !== undefined && r.rank <= k).length;
  const mrrSum = subset.reduce((sum, r) => sum + (r.rank !== undefined ? 1 / r.rank : 0), 0);
  return {
    count,
    recallAt1: hitsAt(1) / count,
    recallAt3: hitsAt(3) / count,
    recallAt5: hitsAt(TOP_K) / count,
    mrr: mrrSum / count,
  };
}

function printMetricsTable(title: string, results: QuestionRunResult[], tags: string[]): void {
  log(`\n--- ${title} ---`);
  log('tag'.padEnd(16) + 'n'.padEnd(5) + 'recall@1'.padEnd(10) + 'recall@3'.padEnd(10) + 'recall@5'.padEnd(10) + 'MRR');
  // Positive questions only - a negative question has no expectedChunks, so
  // its rank is always undefined and it can never contribute a "hit". Left
  // in the denominator, it silently drags the aggregate down below every
  // individual tag's own number (caught exactly this way on a real run:
  // every tag printed 1.00 but "ALL" printed 0.73 = 11/15, a mathematical
  // tell that negatives had leaked into the overall average).
  const positiveResults = results.filter((r) => r.question.expectedChunks.length > 0);
  const overall = computeMetrics(positiveResults);
  log(
    'ALL'.padEnd(16) +
      String(overall.count).padEnd(5) +
      overall.recallAt1.toFixed(2).padEnd(10) +
      overall.recallAt3.toFixed(2).padEnd(10) +
      overall.recallAt5.toFixed(2).padEnd(10) +
      overall.mrr.toFixed(2),
  );
  for (const tag of tags) {
    const m = computeMetrics(results, tag);
    if (m.count === 0) continue;
    log(
      tag.padEnd(16) +
        String(m.count).padEnd(5) +
        m.recallAt1.toFixed(2).padEnd(10) +
        m.recallAt3.toFixed(2).padEnd(10) +
        m.recallAt5.toFixed(2).padEnd(10) +
        m.mrr.toFixed(2),
    );
  }
}

function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
  }
  return dot;
}

/**
 * In-memory only - NEVER touches Atlas, never ingests a second document,
 * never changes production code. Embeds each real chunk's PLAIN `text`
 * (not `embeddingText`, which is what production actually sends - see
 * buildEmbeddingText() in markdown-chunker.ts) via the same cached
 * provider, reuses the SAME query vectors retrieve() already produced
 * (query embedding is identical in both variants - headingPath prefixing
 * only ever applies to document chunks, never queries), and ranks by
 * cosine similarity computed directly here, normalized to [0, 1] via
 * (1 + cosine) / 2 to stay comparable with Atlas's own vectorSearchScore
 * for a cosine index (see PROJECT.md's retrieval contract).
 */
async function runPlainTextExperiment(
  chunks: Chunk[],
  questions: Question[],
  queryVectors: Map<string, number[]>,
  llmProvider: CachingLlmProvider,
): Promise<QuestionRunResult[]> {
  const plainTextResult = await llmProvider.embed(
    chunks.map((c) => c.text),
    'RETRIEVAL_DOCUMENT',
  );
  if (!plainTextResult.ok) {
    throw new Error(`Plain-text experiment embedding failed: ${plainTextResult.error.code}`);
  }
  const chunkVectors = chunks.map((c, i) => ({ headingPath: c.headingPath, position: c.position, vector: plainTextResult.result.vectors[i].values }));

  return questions.map((q) => {
    const queryVector = queryVectors.get(q.id);
    if (!queryVector) {
      throw new Error(`No cached query vector for question ${q.id} - this is a bug in the script, not the data.`);
    }
    const hits: RankedHit[] = chunkVectors
      .map((c) => ({ headingPath: c.headingPath, position: c.position, score: (1 + cosineSimilarity(queryVector, c.vector)) / 2 }))
      .sort((a, b) => b.score - a.score)
      .slice(0, TOP_K);
    return { question: q, hits, rank: rankOfExpected(hits, q.expectedChunks) };
  });
}

async function main(): Promise<void> {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    console.error('MONGODB_URI is not set.');
    process.exitCode = 1;
    return;
  }
  const allowTestDb = process.argv.includes('--allow-test-db');
  try {
    assertNotTestDatabase(uri, allowTestDb);
  } catch (err) {
    console.error((err as Error).message);
    process.exitCode = 1;
    return;
  }

  const llmSettings = loadLlmSettingsFromEnv(process.env);
  if (!llmSettings.geminiApiKey) {
    console.error('GEMINI_API_KEY is not set - this script needs the real Gemini embedder, never FakeLlmProvider.');
    process.exitCode = 1;
    return;
  }

  const cacheDir = process.env.GEMINI_EMBED_FILE_CACHE_DIR || DEFAULT_CACHE_DIR;
  const fileCache = new EmbeddingFileCache(cacheDir);
  log(`Embedding file cache: "${cacheDir}" (set GEMINI_EMBED_FILE_CACHE_DIR to change it)`);
  log(`Embedding model: ${EMBEDDING_MODEL} (dimension ${EMBEDDING_DIMENSION})`);

  const fixturesDir = join(__dirname, '../../../../evals/retrieval-fixtures');
  const policyText = readFileSync(join(fixturesDir, 'sample-policy.md'), 'utf8');
  const fixtures = JSON.parse(readFileSync(join(fixturesDir, 'questions.json'), 'utf8')) as FixturesFile;
  const questions = fixtures.questions;
  const positiveQuestions = questions.filter((q) => q.expectedChunks.length > 0);
  const negativeQuestions = questions.filter((q) => q.expectedChunks.length === 0);
  const tags = [...new Set(positiveQuestions.map((q) => q.tag))];
  log(`Loaded ${questions.length} questions (${positiveQuestions.length} positive, ${negativeQuestions.length} negative).`);

  console.log(`Target database: "${getDatabaseNameFromUri(uri)}"`);
  const tenantId = randomScratchTenantId();
  log(`Scratch tenant: "${tenantId}"`);

  await mongoose.connect(uri);
  mongoose.model('Tenant', TenantSchema);
  mongoose.model('ApiKey', ApiKeySchema);
  const documentModel = mongoose.model<PolicyDocumentDocument>('PolicyDocument', PolicyDocumentSchema);
  const chunkModel = mongoose.model<PolicyChunkDocument>('PolicyChunk', PolicyChunkSchema);

  const documentRepository: PolicyDocumentRepository = new MongoosePolicyDocumentRepository(documentModel);
  const chunkRepository: PolicyChunkRepository = new MongoosePolicyChunkRepository(chunkModel);
  const transactionRunner = new MongooseTransactionRunner(mongoose.connection);

  const realProvider = new GeminiLlmProvider(llmSettings);
  const llmProvider = new CachingLlmProvider(realProvider, fileCache);

  const ingestionSettings = {
    maxFileBytes: 1_000_000,
    titleMaxLength: 200,
    maxChunksPerDocument: 50,
    maxDocumentsPerTenant: 10,
    maxChunksPerTenant: 100,
    embeddingBatchSize: 16,
    ingestionDeadlineMs: 60_000,
    stalePendingMarginMs: 30_000,
  };
  const retrievalSettings = { maxQueryLength: 2000, defaultTopK: TOP_K, maxTopK: 10 };

  const ingestion = new PolicyIngestionService(
    ingestionSettings,
    llmProvider,
    llmSettings,
    new TenantIngestionLock(),
    documentRepository,
    chunkRepository,
    transactionRunner,
  );
  const retrieval = new PolicyRetrievalService(retrievalSettings, llmProvider, llmSettings, chunkRepository);

  try {
    log('--- Ingesting sample-policy.md through the real pipeline (real Gemini, real chunker) ---');
    const ingestResult = await ingestion.ingest({ tenantId, text: policyText, title: 'Thistledown & Pine Returns and Shipping Policy' });
    if (!ingestResult.ok) {
      throw new Error(`Ingestion failed: [${ingestResult.code}] ${ingestResult.message}`);
    }
    log(`Ingested document ${ingestResult.document.id} (${ingestResult.document.chunkCount} chunks).`);

    await pollUntilSearchable(retrieval, tenantId, positiveQuestions[0].question, ingestResult.document.id);

    log(`\n--- Running ${questions.length} questions through retrieve() (topK ${TOP_K}, production embedding) ---`);
    const queryVectors = new Map<string, number[]>();
    const productionResults: QuestionRunResult[] = [];
    for (const q of questions) {
      const result = await retrieval.retrieve(tenantId, q.question, { topK: TOP_K });
      if (!result.ok) {
        throw new Error(`retrieve() failed for ${q.id}: [${result.error.code}] ${result.error.message}`);
      }
      const hits: RankedHit[] = result.results.map((r) => ({ headingPath: r.headingPath, position: r.position, score: r.score }));
      productionResults.push({ question: q, hits, rank: rankOfExpected(hits, q.expectedChunks) });

      // Capture the query vector for reuse in the plain-text experiment -
      // a cache hit (same text/taskType/model/dimension), never a second
      // real network call, confirmed by CachingLlmProvider's own
      // realCalls/cacheHits counters printed at the end.
      const embedOutcome = await llmProvider.embed([q.question], 'RETRIEVAL_QUERY');
      if (embedOutcome.ok) {
        queryVectors.set(q.id, embedOutcome.result.vectors[0].values);
      }
    }

    // --- Per-question report (headingPath labels and scores only, never chunk text). ---
    log('\n--- Per-question results (production embedding) ---');
    log('id'.padEnd(6) + 'tag'.padEnd(16) + 'rank'.padEnd(6) + 'top1'.padEnd(8) + 'top1-top2 gap');
    for (const r of productionResults) {
      const top1 = r.hits[0]?.score;
      const top2 = r.hits[1]?.score;
      const gap = top1 !== undefined && top2 !== undefined ? (top1 - top2).toFixed(3) : 'n/a';
      log(
        r.question.id.padEnd(6) +
          r.question.tag.padEnd(16) +
          (r.rank ?? '-').toString().padEnd(6) +
          (top1 !== undefined ? top1.toFixed(3) : 'n/a').padEnd(8) +
          gap,
      );
    }

    // --- Score distributions: positive top-1 vs negative top-1, for
    // visual threshold-separability inspection only - no threshold chosen. ---
    const positiveTop1Scores = productionResults.filter((r) => r.question.expectedChunks.length > 0).map((r) => r.hits[0]?.score).filter((s): s is number => s !== undefined);
    const negativeTop1Scores = productionResults.filter((r) => r.question.expectedChunks.length === 0).map((r) => r.hits[0]?.score).filter((s): s is number => s !== undefined);
    log('\n--- Top-1 score distribution ---');
    log(`Positive questions (n=${positiveTop1Scores.length}): [${positiveTop1Scores.map((s) => s.toFixed(3)).join(', ')}]`);
    log(`Negative questions (n=${negativeTop1Scores.length}): [${negativeTop1Scores.map((s) => s.toFixed(3)).join(', ')}]`);
    if (positiveTop1Scores.length > 0 && negativeTop1Scores.length > 0) {
      const minPositive = Math.min(...positiveTop1Scores);
      const maxNegative = Math.max(...negativeTop1Scores);
      log(`Lowest positive top-1 score: ${minPositive.toFixed(3)} | Highest negative top-1 score: ${maxNegative.toFixed(3)}`);
      log(
        minPositive > maxNegative
          ? `A gap exists (${(minPositive - maxNegative).toFixed(3)}) - but see docs/learning-notes.md for whether ${positiveQuestions.length} questions is enough to trust it.`
          : 'No clean gap - the lowest positive score does not exceed the highest negative score. No threshold would cleanly separate these two groups on this data.',
      );
    }

    printMetricsTable('Production embedding (headingPath + text, current behavior)', productionResults, tags);

    // --- Experiment: plain text only, in-memory, no second ingest. ---
    log('\n--- Running the plain-text-only experiment (in-memory, no Atlas writes) ---');
    const chunkResult = chunkMarkdown(policyText, { documentSlug: 'doc', maxChunks: ingestionSettings.maxChunksPerDocument });
    if (!chunkResult.ok) {
      throw new Error(`Local chunking for the experiment failed: ${chunkResult.error.code}`);
    }
    const experimentResults = await runPlainTextExperiment(chunkResult.chunks, questions, queryVectors, llmProvider);
    printMetricsTable('Experiment: plain chunk text only (NOT production behavior)', experimentResults, tags);

    log(`\nEmbedding calls this run: ${llmProvider.realCalls} real (network) call(s), ${llmProvider.cacheHits} served from the file cache.`);

    // --- Failure diagnosis (production variant only - what actually ships). ---
    const failures = productionResults.filter((r) => r.question.expectedChunks.length > 0 && r.rank === undefined);
    log(`\n--- Failure diagnosis (${failures.length} of ${positiveQuestions.length} positive questions missed top-${TOP_K}) ---`);
    const MERGED_CHUNK_POSITIONS = new Set(chunkResult.chunks.filter((c) => c.approxTokens > 150).map((c) => c.position));
    for (const f of failures) {
      const retrievedTop1 = f.hits[0];
      const expectedInMergedChunk = f.question.expectedChunks.some((e) => MERGED_CHUNK_POSITIONS.has(e.position));
      const diagnosis = expectedInMergedChunk
        ? 'possible chunk-merging / heading-context loss - the expected chunk is a merged section whose heading label no longer names this sub-topic (see docs/learning-notes.md\'s Stage 8 entry for which chunks merged)'
        : 'possible vocabulary mismatch - the question shares little wording with the policy and the expected chunk was not a merged one, so a thin heading label is a less likely explanation';
      log(`${f.question.id} [${f.question.tag}]: expected ${JSON.stringify(f.question.expectedChunks.map((e) => e.headingPath))}`);
      log(`  retrieved instead (top-1): ${retrievedTop1 ? retrievedTop1.headingPath : '(no results at all)'}`);
      log(`  diagnosis (heuristic, not certain): ${diagnosis}`);
    }
    if (failures.length === 0) {
      log('No positive-question failures to diagnose.');
    }

    log('\nDone. See docs/learning-notes.md for the recorded results of a specific run.');
  } finally {
    log('\nCleaning up scratch tenant...');
    await chunkRepository.deleteForTenant(tenantId);
    await documentModel.deleteMany({ tenantId });
    log('Cleanup complete.');
    await mongoose.disconnect();
  }
}

main().catch((err: unknown) => {
  console.error('retrieval-quality-check failed:', err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
