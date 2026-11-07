/**
 * Vitest's globalSetup: runs exactly ONCE in the root orchestrating
 * process, before any worker is spawned and before any spec file is
 * loaded - structurally eliminating the race that per-file
 * `beforeAll(() => ensureTestIndexes(uri))` had. That per-file approach's
 * "only run once" guard was a module-level variable, but vitest runs each
 * spec file in its own isolated worker process by default - the guard
 * only protected one file at a time, not the 7 files racing each other.
 * Confirmed for real in CI: two files simultaneously saw the index didn't
 * exist yet and both called the real, non-idempotent createSearchIndex,
 * and the loser got MongoServerError: duplicate index names.
 *
 * ensureTestIndexes itself now closes its own mongoose connection (a
 * try/finally around its whole body) before returning - a real leak,
 * found via a CI run's hanging-process reporter output, that otherwise
 * left MongoDB driver sockets/timers open in THIS root process for the
 * rest of the run. See ensure-test-indexes.ts's own doc comment for the
 * full evidence; no separate teardown is needed here as a result.
 */
import { ensureTestIndexes } from './ensure-test-indexes';
import { getTestMongoUri, integrationTestsEnabled } from './test-env';

export default async function setup(): Promise<void> {
  if (!integrationTestsEnabled()) {
    return;
  }
  await ensureTestIndexes(getTestMongoUri(), (message) => console.log(`[global-setup] ${message}`));
}
