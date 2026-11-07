import { defineConfig } from 'vitest/config';
import swc from 'unplugin-swc';

/**
 * A SEPARATE config from vitest.config.mts (which stays fast and
 * database-free) specifically so `pnpm run test` never tries to run these -
 * only `pnpm run test:integration`, which requires MONGODB_TEST_URI to do
 * anything (test files skip cleanly otherwise - see test/integration/test-env.ts).
 *
 * Deliberately no `fileParallelism` override: spec files use their own
 * randomly-generated tenant ids, so concurrent files never collide on
 * DATA. The one thing they'd collide on - creating the shared search index
 * the first time - is handled once, up front, by globalSetup below, not by
 * each file's own beforeAll (see global-setup.ts's comment for the real
 * race that approach had, confirmed in CI).
 */
export default defineConfig({
  test: {
    include: ['test/integration/**/*.integration-spec.ts'],
    setupFiles: ['test/integration/test-env.ts'],
    globalSetup: ['test/integration/global-setup.ts'],
    // Explicit, not just relying on vitest's current default: several specs
    // (embedding-failure, quota-and-concurrency) set and delete
    // process.env.INGESTION_* for the duration of their own beforeAll/afterAll,
    // to force a specific batch size or quota. With isolate: false, vitest
    // reuses one worker process across multiple spec files - those env
    // mutations would then leak into whichever other file happens to share
    // that worker, corrupting its settings nondeterministically depending on
    // scheduling. isolate: true (one process per file) is what makes each
    // file's env mutations safely local to itself. Do not flip this for
    // speed (vitest's own CLI output suggests it) without first making every
    // env-mutating spec restore state some other way.
    isolate: true,
    // 90s: comfortably above pollUntil's own 60s budget (test/integration/poll.ts) -
    // the real, documented ceiling for Atlas's insert-to-searchable lag - plus margin.
    testTimeout: 90_000,
    // 30s: beforeAll/afterAll now only boot/close the app and clean up a
    // tenant - no index creation happens here anymore (that moved to
    // globalSetup, below). Confirmed vitest applies hookTimeout to
    // beforeAll/afterAll but NOT to globalSetup itself (vitest has no
    // default timeout for globalSetup at all) - so globalSetup's own
    // budget is governed by ensureIndexes()'s real QUERYABLE_TIMEOUT_MS
    // (120s, db-ensure-indexes.ts), not by this value. The CI job's own
    // timeout-minutes is what bounds globalSetup from the outside.
    hookTimeout: 30_000,
    expect: {
      requireAssertions: true,
    },
    /**
     * TEMPORARY, pending a real CI run against Atlas Local - remove once
     * that run's output is captured and the hang is understood. A real CI
     * run reported "close timed out after 10000ms ... something prevents 2
     * Vite servers from exiting" after Stage 6's four new chat-*.
     * integration-spec.ts files were added. Investigated directly (not
     * guessed): booted AppModule repeatedly, sent real supertest requests
     * through it, started/stopped the in-process mock-store, and ran a
     * full real get_order call through the real tool runner's own HTTP
     * client - all against a real standalone local mongod, with every
     * app/server closed and Node's own `_getActiveHandles()` checked
     * afterward. Every one of those came back clean (0 leaked handles).
     * The one thing none of that could exercise: a REAL replica-set
     * topology (Atlas Local, even single-node, runs as one) - the MongoDB
     * driver's topology monitor does periodic heartbeat/connect calls
     * against each known server with `connectTimeoutMS`/
     * `heartbeatFrequencyMS` both defaulting to exactly 10000ms, which a
     * plain standalone-mongod connection's simpler topology never
     * exercises the same way. That number matching the reported "10000ms"
     * is suggestive, not confirmed - `['default', 'hanging-process']` adds
     * vitest's own built-in hanging-process reporter (no new dependency)
     * so the NEXT real CI run names the actual open handle directly,
     * instead of this being reasoned about from a number alone.
     */
    reporters: ['default', 'hanging-process'],
  },
  plugins: [swc.vite()],
});
