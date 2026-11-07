/**
 * Reuses the exact same index-management functions and wiring the
 * db:ensure-indexes script uses (src/scripts/db-ensure-indexes.ts) against
 * the one fixed test database, so the integration suite never duplicates
 * that logic and is proven to set up the test database the identical way a
 * developer would via `pnpm run db:ensure-indexes -- --allow-test-db`
 * (Stage 7 item 5).
 *
 * Called exactly once, from global-setup.ts's vitest globalSetup hook -
 * NOT from individual spec files' beforeAll. That per-file approach was
 * the original design and raced for real in CI: vitest runs each spec
 * file in its own worker process, so a module-level "only once" guard
 * like the one below only protects one file at a time, and two files
 * simultaneously calling the real, non-idempotent createSearchIndex
 * produced "duplicate index names" (see global-setup.ts and
 * docs/learning-notes.md). The `ensured` guard below stays as cheap
 * defense-in-depth against a future accidental second call within the
 * same process, not as the actual concurrency guarantee - that guarantee
 * is globalSetup running once, in one process, before any worker spawns.
 *
 * Stage 4, Stage 2 item 5: this previously called ONLY ensureIndexes (the
 * Atlas Vector Search index on PolicyChunk) - a real gap, not just for the
 * four new chat collections but for every model: the unique index on
 * ApiKey.hash, the lookup indexes on PolicyDocument, etc. were never
 * actually created in the test database at all. Now calls
 * `buildIndexPlans` (every model, every TTL collection) via
 * `ensureCollectionIndexes`, so the integration suite exercises the exact
 * same index set a real deployment would have - including the
 * CustomerPublicKey unique index tests for duplicate-kid rejection would
 * otherwise never actually prove.
 *
 * `buildIndexPlans` is imported (not reimplemented here) specifically so
 * this file can never drift from the script's own wiring the way the
 * earlier ensureRegularIndexes/ensureTtlIndexes split did (see the module
 * doc comment on `ensureCollectionIndexes` for that bug's root cause).
 *
 * REAL LEAK, found via a CI run's hanging-process reporter output: this
 * function's own `mongoose.connect(uri)` was never matched by a
 * disconnect, on ANY path (success, a thrown error from the index-ensure
 * work, or `ensureIndexes`'s own internal QUERYABLE_TIMEOUT_MS firing) -
 * no try/finally existed at all. That connection runs in vitest's ROOT
 * process (globalSetup, per this file's own doc comment above), a
 * DIFFERENT process from every worker/spec-file's own connections
 * (tenant-fixture.ts's `mongoose.connect()`, each worker's own
 * DatabaseModule) - so this was never visible from inside any individual
 * spec file's own close()/disconnect() calls, only from the root
 * process's own open handles after every worker finished. The hanging-
 * process reporter's dump matched this exactly: MongoDB driver TCPWRAP
 * sockets plus the topology monitor's heartbeat `setTimeout` (monitor.js)
 * and the connection pool's `minPoolSizeTimer` (connection_pool.js) - the
 * standard signature of an established Mongoose connection that was never
 * closed, not a vague "something's open" guess. Fixed with a try/finally
 * around the entire connect+index-ensure body, so `mongoose.disconnect()`
 * runs whether the body succeeds, throws, or times out - the same
 * generic shape this project already uses elsewhere for guaranteed
 * cleanup (e.g. ChatService's own `finally { lock.release(); }`).
 */
import mongoose from 'mongoose';
import { assertIsTestDatabase } from '../../src/db/database-name';
import { buildIndexPlans, ensureCollectionIndexes, ensureIndexes } from '../../src/scripts/db-ensure-indexes';

let ensured = false;

export async function ensureTestIndexes(uri: string, log: (message: string) => void = () => {}): Promise<void> {
  if (ensured) {
    return;
  }
  assertIsTestDatabase(uri);

  try {
    await mongoose.connect(uri);

    // A short, fixed retention period in tests - exercising the real
    // TTL-index code path (and the real index it creates) without needing
    // CHAT_RETENTION_DAYS set; the integration tests only check the index's
    // existence/shape, never wait out a real 30-day expiry.
    const testExpireAfterSeconds = 30 * 24 * 60 * 60;
    const { collectionPlans, vectorSearchDeps } = buildIndexPlans(testExpireAfterSeconds);

    for (const plan of collectionPlans) {
      await ensureCollectionIndexes(plan, log);
    }
    await ensureIndexes(vectorSearchDeps, log);
    ensured = true;
  } finally {
    await mongoose.disconnect();
  }
}
