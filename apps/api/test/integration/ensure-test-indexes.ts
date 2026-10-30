/**
 * Reuses the exact same index-management functions the db:ensure-indexes
 * script uses (src/scripts/db-ensure-indexes.ts) against the one fixed
 * test database, so the integration suite never duplicates that logic and
 * is proven to set up the test database the identical way a developer
 * would via `pnpm run db:ensure-indexes -- --allow-test-db` (Stage 7 item 5).
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
 */
import mongoose from 'mongoose';
import { assertIsTestDatabase } from '../../src/db/database-name';
import { ensureIndexes, EnsureIndexDeps } from '../../src/scripts/db-ensure-indexes';
import { PolicyChunkSchema } from '../../src/db/schemas/policy-chunk.schema';

let ensured = false;

export async function ensureTestIndexes(uri: string, log: (message: string) => void = () => {}): Promise<void> {
  if (ensured) {
    return;
  }
  assertIsTestDatabase(uri);
  await mongoose.connect(uri);

  const model = mongoose.model('PolicyChunk', PolicyChunkSchema);
  const deps: EnsureIndexDeps = {
    listCollectionNames: async () => {
      const collections = await mongoose.connection.db!.listCollections({ name: 'policyChunks' }).toArray();
      return collections.map((c) => c.name);
    },
    createCollection: async () => {
      await model.createCollection();
    },
    listSearchIndexes: async () => (await model.listSearchIndexes()) as unknown as Awaited<ReturnType<EnsureIndexDeps['listSearchIndexes']>>,
    createSearchIndex: async (description) =>
      model.createSearchIndex(description as unknown as Parameters<typeof model.createSearchIndex>[0]),
  };

  await ensureIndexes(deps, log);
  ensured = true;
}
