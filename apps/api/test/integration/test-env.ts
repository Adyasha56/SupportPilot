/**
 * Gate for the whole integration suite (Stage 7). Deliberately a SEPARATE
 * env var from MONGODB_URI: the app's own MONGODB_URI (if a developer has
 * one set for `pnpm dev`) must never be mistaken for the one fixed test
 * database, and a test run must never accidentally point at it.
 *
 * Every integration spec file does:
 *   describe.skipIf(!integrationTestsEnabled())('...', () => { ... })
 * so the suite reports as skipped (not failed, not silently absent) when
 * MONGODB_TEST_URI isn't set - the normal state for a local run without a
 * real cluster, and never the state in CI (the Atlas Local job always sets it).
 */
import { assertIsTestDatabase } from '../../src/db/database-name';

export function integrationTestsEnabled(): boolean {
  return Boolean(process.env.MONGODB_TEST_URI);
}

/**
 * Throws loudly (never a silent skip) if MONGODB_TEST_URI is set but does
 * NOT look like the shared test database - a misconfigured env var must
 * fail the run, not quietly run against a real database.
 */
export function getTestMongoUri(): string {
  const uri = process.env.MONGODB_TEST_URI;
  if (!uri) {
    throw new Error('MONGODB_TEST_URI is not set - call integrationTestsEnabled() first and skip if false.');
  }
  assertIsTestDatabase(uri);
  return uri;
}

/**
 * Sets up the process env the app itself reads at module-load time
 * (AppModule/DatabaseModule/AuthModule/IngestionModule/RetrievalModule all
 * read process.env.MONGODB_URI directly - see app.module.ts) before
 * AppModule is ever imported. Must run from a vitest `setupFiles` entry,
 * which vitest guarantees runs before the test file's own module graph is
 * evaluated - never from inside a test or a beforeAll, which would be too late.
 *
 * GEMINI_API_KEY is set to a dummy, non-empty value so LlmSettings reports
 * "configured" (routes don't 503) - no real key is needed because
 * LLM_PROVIDER itself is overridden with FakeLlmProvider in every
 * integration test's TestingModule, so this value is never sent anywhere.
 */
export function wireTestEnv(): void {
  if (!integrationTestsEnabled()) {
    return;
  }
  process.env.MONGODB_URI = getTestMongoUri();
  if (!process.env.GEMINI_API_KEY) {
    process.env.GEMINI_API_KEY = 'test-dummy-key-never-sent-fake-llm-provider-is-used-instead';
  }
}

wireTestEnv();
