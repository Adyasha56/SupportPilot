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
 */
import { ensureTestIndexes } from './ensure-test-indexes';
import { getTestMongoUri, integrationTestsEnabled } from './test-env';

export default async function setup(): Promise<void> {
  if (!integrationTestsEnabled()) {
    return;
  }
  await ensureTestIndexes(getTestMongoUri(), (message) => console.log(`[global-setup] ${message}`));
}
