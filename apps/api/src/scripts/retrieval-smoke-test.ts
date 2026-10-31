/**
 * Manual only - never run in CI, never run automatically. Exercises the
 * real ingestion and retrieval services, through the real Mongoose
 * repositories, against your real Atlas cluster - but with FakeLlmProvider
 * standing in for Gemini, so it spends no quota and sends no document text
 * anywhere outside this process.
 *
 * Uses two random scratch tenant ids and deletes every document and chunk
 * it created, by tenant id, in a `finally` block - success or failure.
 * Refuses to run against a database name starting with "test_" unless
 * --allow-test-db is passed, same guard as every other script here.
 *
 * Compiled to dist/scripts and run as plain JS, same reasoning as every
 * other script (Node's native TypeScript stripping doesn't support
 * decorators/constructor parameter properties - none of the classes this
 * script constructs are instantiated through Nest's DI container, so
 * their @Inject()/@Optional()/@InjectModel() decorators are inert here;
 * this just calls `new SomeService(...)` directly with real dependencies).
 *
 *   pnpm run retrieval-smoke-test
 */
import { randomBytes } from 'node:crypto';
import mongoose from 'mongoose';
import { assertNotTestDatabase, getDatabaseNameFromUri } from '../db/database-name';
import { MongoosePolicyChunkRepository, PolicyChunkRepository } from '../db/policy-chunk.repository';
import { MongoosePolicyDocumentRepository, PolicyDocumentRepository } from '../db/policy-document.repository';
import { MongooseTransactionRunner } from '../db/transaction-runner';
import { ApiKeySchema } from '../db/schemas/api-key.schema';
import { PolicyChunkDocument, PolicyChunkSchema } from '../db/schemas/policy-chunk.schema';
import { PolicyDocumentDocument, PolicyDocumentSchema } from '../db/schemas/policy-document.schema';
import { TenantSchema } from '../db/schemas/tenant.schema';
import { PolicyIngestionService } from '../ingestion/policy-ingestion.service';
import { TenantIngestionLock } from '../ingestion/tenant-ingestion-lock';
import { FakeLlmProvider } from '../llm/test-utils/fake-llm-provider';
import { PolicyRetrievalService } from '../retrieval/policy-retrieval.service';

const POLL_INTERVAL_MS = 2000;
const POLL_TIMEOUT_MS = 60_000;

function randomScratchTenantId(label: 'a' | 'b'): string {
  return `smoke-${label}-${randomBytes(4).toString('hex')}`;
}

function log(message: string): void {
  console.log(message);
}

async function pollUntilSearchable(
  retrieval: PolicyRetrievalService,
  tenantId: string,
  query: string,
  expectedDocumentId: string,
): Promise<number> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < POLL_TIMEOUT_MS) {
    const result = await retrieval.retrieve(tenantId, query, { topK: 1 });
    if (result.ok && result.results.length > 0 && result.results[0].documentId === expectedDocumentId) {
      return (Date.now() - startedAt) / 1000;
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
  throw new Error(`Timed out after ${POLL_TIMEOUT_MS / 1000}s waiting for tenant ${tenantId}'s chunk to become searchable.`);
}

/** Returns seconds until `goneDocumentId` stops appearing, or null if it never does within the timeout - informational only, never a hard assertion. */
async function pollUntilGone(
  retrieval: PolicyRetrievalService,
  tenantId: string,
  query: string,
  goneDocumentId: string,
): Promise<number | null> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < POLL_TIMEOUT_MS) {
    const result = await retrieval.retrieve(tenantId, query, { topK: 5 });
    const stillThere = result.ok && result.results.some((r) => r.documentId === goneDocumentId);
    if (!stillThere) {
      return (Date.now() - startedAt) / 1000;
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
  return null;
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

  console.log(`Target database: "${getDatabaseNameFromUri(uri)}"`);

  const tenantA = randomScratchTenantId('a');
  const tenantB = randomScratchTenantId('b');
  console.log(`Scratch tenants: "${tenantA}", "${tenantB}"`);

  // A single plain mongoose.connect() - the SAME connection the models
  // below are registered on and the transaction runner starts sessions
  // from. Deliberately NOT @nestjs/mongoose's MongooseModule.forRoot(),
  // which uses mongoose.createConnection() internally (a separate,
  // isolated connection) - mixing the two was a real bug, found and fixed
  // in the app itself (see docs/learning-notes.md): a session started on
  // the wrong connection buffers every operation until it times out.
  await mongoose.connect(uri);

  // Registering unused schemas (Tenant, ApiKey) is harmless and keeps this
  // script's model registration consistent with the real app's; only
  // PolicyDocument and PolicyChunk are actually used below.
  mongoose.model('Tenant', TenantSchema);
  mongoose.model('ApiKey', ApiKeySchema);
  // Explicit generics: a bare mongoose.model(name, schema) infers a
  // slightly different (incompatible) virtual-`id` type than
  // Model<PolicyDocumentDocument> - confirmed directly, tsc rejects
  // passing the untyped result into MongoosePolicyDocumentRepository's
  // constructor otherwise.
  const documentModel = mongoose.model<PolicyDocumentDocument>('PolicyDocument', PolicyDocumentSchema);
  const chunkModel = mongoose.model<PolicyChunkDocument>('PolicyChunk', PolicyChunkSchema);

  const documentRepository: PolicyDocumentRepository = new MongoosePolicyDocumentRepository(documentModel);
  const chunkRepository: PolicyChunkRepository = new MongoosePolicyChunkRepository(chunkModel);
  const transactionRunner = new MongooseTransactionRunner(mongoose.connection);

  const llmProvider = new FakeLlmProvider();
  const llmSettings = {
    geminiApiKey: 'fake-key-never-used-by-FakeLlmProvider',
    requestsPerMinute: 1000,
    maxConcurrency: 1000,
    maxRetries: 0,
    requestTimeoutMs: 5000,
    maxTextsPerBatch: 32,
    maxCharsPerText: 8000,
    cacheMaxEntries: 500,
    generateModel: 'gemini-3.5-flash-lite',
    generateRequestsPerMinute: 1000,
    generateMaxConcurrency: 1000,
    generateMaxRetries: 0,
    generateTimeoutMs: 5000,
    generateMaxOutputTokens: 1024,
    generateTemperature: 0,
  };
  const ingestionSettings = {
    maxFileBytes: 1_000_000,
    titleMaxLength: 200,
    maxChunksPerDocument: 50,
    maxDocumentsPerTenant: 10,
    maxChunksPerTenant: 100,
    embeddingBatchSize: 16,
    ingestionDeadlineMs: 30_000,
    stalePendingMarginMs: 30_000,
  };
  const retrievalSettings = { maxQueryLength: 2000, defaultTopK: 5, maxTopK: 10 };

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
    // Two short, deliberately UNRELATED documents - sharing no words at
    // all, so under FakeLlmProvider's word-hash embedder, a query copied
    // verbatim from one document is the closest possible match to it, and
    // should be as far as possible from the other.
    const docA = '# Return Policy\n\nCustomers may return unworn shoes within 14 days for a full refund of the purchase price.';
    const docB = '# Grooming Salon Hours\n\nThe pet grooming salon is open Tuesday through Saturday from nine in the morning.';

    const resultA = await ingestion.ingest({ tenantId: tenantA, text: docA, title: 'Return Policy' });
    const resultB = await ingestion.ingest({ tenantId: tenantB, text: docB, title: 'Grooming Salon Hours' });
    if (!resultA.ok || !resultB.ok) {
      throw new Error(`Ingestion failed: A=${resultA.ok ? 'ok' : resultA.code}, B=${resultB.ok ? 'ok' : resultB.code}`);
    }
    log(`Ingested tenant A document ${resultA.document.id} (${resultA.document.chunkCount} chunk(s))`);
    log(`Ingested tenant B document ${resultB.document.id} (${resultB.document.chunkCount} chunk(s))`);

    const queryA = 'unworn shoes within 14 days for a full refund';
    const queryB = 'grooming salon is open Tuesday through Saturday';

    const secondsA = await pollUntilSearchable(retrieval, tenantA, queryA, resultA.document.id);
    log(`Tenant A's chunk became searchable after ${secondsA.toFixed(1)}s`);
    const secondsB = await pollUntilSearchable(retrieval, tenantB, queryB, resultB.document.id);
    log(`Tenant B's chunk became searchable after ${secondsB.toFixed(1)}s`);

    // Cross-tenant isolation: query AS tenant A using tenant B's own text
    // (the closest possible vector match, if isolation were broken) and
    // assert nothing comes back at all.
    const crossA = await retrieval.retrieve(tenantA, queryB, { topK: 5 });
    const crossB = await retrieval.retrieve(tenantB, queryA, { topK: 5 });
    if (!crossA.ok || !crossB.ok) {
      throw new Error('Cross-tenant isolation check itself failed to run.');
    }
    const crossALeaked = crossA.results.some((r) => r.documentId === resultB.document.id);
    const crossBLeaked = crossB.results.some((r) => r.documentId === resultA.document.id);
    log(`Tenant A queried with tenant B's text: ${crossA.results.length} result(s), leaked tenant B content: ${crossALeaked}`);
    log(`Tenant B queried with tenant A's text: ${crossB.results.length} result(s), leaked tenant A content: ${crossBLeaked}`);
    if (crossALeaked || crossBLeaked) {
      throw new Error('TENANT ISOLATION FAILURE: a result leaked across tenants.');
    }

    // Raw scores.
    const ownA = await retrieval.retrieve(tenantA, queryA, { topK: 3 });
    if (ownA.ok) {
      const scores = ownA.results.map((r) => r.score);
      log(`Raw vectorSearchScore values for tenant A's own query: [${scores.join(', ')}]`);
      log(`All within [0, 1]: ${scores.every((s) => s >= 0 && s <= 1)}`);
    }

    // Exact (ENN) vs approximate (ANN).
    const exactResult = await retrieval.retrieve(tenantA, queryA, { topK: 3, exact: true });
    const approxResult = await retrieval.retrieve(tenantA, queryA, { topK: 3, exact: false });
    if (exactResult.ok && approxResult.ok) {
      const exactKeys = exactResult.results.map((r) => r.chunkKey);
      const approxKeys = approxResult.results.map((r) => r.chunkKey);
      log(`Exact (ENN) chunkKeys: [${exactKeys.join(', ')}]`);
      log(`Approximate (ANN) chunkKeys: [${approxKeys.join(', ')}]`);
      log(`Exact and approximate agree: ${JSON.stringify(exactKeys) === JSON.stringify(approxKeys)}`);
    }

    // --- Deactivation: diagnose, then assert (the hard assertion expects
    // an IMMEDIATE 0 - the defense-in-depth fix means this must never
    // depend on index freshness; the poll below is purely informational,
    // measuring how long the pre-filter's own lag would otherwise last). ---
    log('--- Deactivating tenant A\'s chunk and diagnosing ---');
    const docObjectIdA = new mongoose.Types.ObjectId(resultA.document.id);

    const rawUpdateResult = await chunkModel.updateMany({ tenantId: tenantA, documentId: docObjectIdA }, { $set: { active: false } });
    log(`Deactivation write: matched ${rawUpdateResult.matchedCount}, modified ${rawUpdateResult.modifiedCount}`);

    const storedChunksAfterDeactivate = await chunkModel.find({ tenantId: tenantA, documentId: docObjectIdA }).select('active').lean();
    log(`Direct collection read, 'active' value(s): ${JSON.stringify(storedChunksAfterDeactivate.map((c) => c.active))}`);

    // Field-freshness experiment: does $vectorSearch's own $project output
    // reflect the CURRENT collection value for a field, even if the index
    // still surfaces the document as a stale candidate? Checked via the
    // repository directly (not retrieve(), which already applies the new
    // defense-in-depth filtering) so this measures the RAW search output.
    const queryEmbedResult = await llmProvider.embed([queryA], 'RETRIEVAL_QUERY');
    if (!queryEmbedResult.ok) {
      throw new Error(`Unexpected: FakeLlmProvider.embed() failed: ${queryEmbedResult.error.code}`);
    }
    const rawSearchImmediate = await chunkRepository.vectorSearch({
      tenantId: tenantA,
      queryVector: queryEmbedResult.result.vectors[0].values,
      limit: 5,
      exact: true,
    });
    const rawMatch = rawSearchImmediate.find((r) => r.documentId === resultA.document.id);
    if (rawMatch) {
      log(
        `Immediately after deactivation, raw $vectorSearch still returned this chunk as a candidate - its projected 'active' field: ${rawMatch.active}`,
      );
      log(`Field freshness: projected 'active' matches the live collection value: ${rawMatch.active === storedChunksAfterDeactivate[0]?.active}`);
    } else {
      log('Immediately after deactivation, raw $vectorSearch no longer returned this chunk as a candidate at all (no lag observed on this attempt).');
    }

    const immediateAfterDeactivate = await retrieval.retrieve(tenantA, queryA, { topK: 5 });
    log(
      `Immediately after deactivation, retrieve() (with the defense-in-depth fix) returned: ${
        immediateAfterDeactivate.ok ? JSON.stringify(immediateAfterDeactivate.results.map((r) => r.documentId)) : 'an error'
      }`,
    );

    // Informational only - never thrown on.
    const goneAfterSeconds = await pollUntilGone(retrieval, tenantA, queryA, resultA.document.id);
    if (rawMatch) {
      if (goneAfterSeconds === null) {
        log(`DIAGNOSIS: the raw pre-filter still had NOT excluded this chunk after ${POLL_TIMEOUT_MS / 1000}s of polling.`);
      } else {
        log(`DIAGNOSIS (informational): the pre-filter's own index lag cleared after ${goneAfterSeconds.toFixed(1)}s - retrieve() itself was already correct the whole time because of the fix above.`);
      }
    }

    // The hard assertion: with the fix, this must be 0 immediately, not eventually.
    if (!immediateAfterDeactivate.ok || immediateAfterDeactivate.results.length !== 0) {
      throw new Error('INACTIVE CHUNK LEAK: a deactivated chunk was still returned by retrieve() immediately after deactivation.');
    }
    log('Immediate post-deactivation check passed (0 results, as required).');

    // --- Deletion: the same lag can apply to a hard delete. A deleted
    // document can never be "read live" to confirm its current state (it
    // doesn't exist), so this checks retrieve() itself never leaks it,
    // rather than inspecting field freshness the way deactivation allows. ---
    log('--- Deleting tenant B\'s chunk and checking immediately ---');
    await chunkRepository.deleteForDocument(tenantB, resultB.document.id);
    const immediateAfterDelete = await retrieval.retrieve(tenantB, queryB, { topK: 5 });
    log(
      `Immediately after deletion, retrieve() returned: ${
        immediateAfterDelete.ok ? JSON.stringify(immediateAfterDelete.results.map((r) => r.documentId)) : 'an error'
      }`,
    );
    if (!immediateAfterDelete.ok || immediateAfterDelete.results.some((r) => r.documentId === resultB.document.id)) {
      throw new Error('DELETED CHUNK LEAK: a deleted chunk was still returned by retrieve() immediately after deletion.');
    }
    log('Immediate post-deletion check passed.');

    log('RESULT: all checks passed.');
  } catch (err) {
    console.error('RESULT: smoke test failed.');
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  } finally {
    log('Cleaning up scratch tenants...');
    await chunkRepository.deleteForTenant(tenantA);
    await chunkRepository.deleteForTenant(tenantB);
    await documentModel.deleteMany({ tenantId: { $in: [tenantA, tenantB] } });
    log('Cleanup complete.');
    await mongoose.disconnect();
  }
}

main().catch((err: unknown) => {
  console.error('retrieval-smoke-test failed:', err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
