import { defineConfig } from 'vitest/config';
import swc from 'unplugin-swc';

/**
 * A SEPARATE config from vitest.config.mts (which stays fast and
 * database-free) specifically so `pnpm run test` never tries to run these -
 * only `pnpm run test:integration`, which requires MONGODB_TEST_URI to do
 * anything (test files skip cleanly otherwise - see test/integration/test-env.ts).
 * Deliberately no `fileParallelism` override: integration spec files each
 * use their own randomly-generated tenant ids (see tenant-fixture.ts), so
 * concurrent files never collide, and default parallelism keeps wall-clock
 * time down against a database with real network latency.
 */
export default defineConfig({
  test: {
    include: ['test/integration/**/*.integration-spec.ts'],
    setupFiles: ['test/integration/test-env.ts'],
    testTimeout: 90_000,
    hookTimeout: 150_000,
    expect: {
      requireAssertions: true,
    },
  },
  plugins: [swc.vite()],
});
