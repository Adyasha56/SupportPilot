import 'reflect-metadata';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { IngestionModule, ingestionDatabaseImportsFor } from './ingestion.module';
import { DatabaseModule } from '../db/database.module';
import { AuthModule } from '../auth/auth.module';
import { LlmModule } from '../llm/llm.module';

/**
 * A real NestJS bug, caught only by running the real server against a real
 * .env, not by any unit or controller test: IngestionModule never imported
 * DatabaseModule itself, so PoliciesController/PolicyIngestionService's
 * @Optional() repository tokens silently resolved to undefined even with
 * MONGODB_URI set - Nest module providers aren't visible across sibling
 * imports just because they share a parent (AppModule). The
 * controller-level tests never caught this because they hand-provide
 * repositories directly, bypassing this exact import graph.
 *
 * Previously this whole file worked by stubbing MONGODB_URI and dynamically
 * re-importing ingestion.module.ts (with vi.resetModules()) for EVERY
 * scenario, to see IngestionModule's own module-load-time env read take a
 * different value each time. That was a real, measured source of
 * intermittent CI-grade flakiness - NOT because of any real Mongoose
 * connection or DNS lookup (confirmed directly by reading @nestjs/mongoose's
 * own source: MongooseModule.forRoot() only builds a DynamicModule
 * descriptor; mongoose.createConnection() lives inside a useFactory
 * provider that Nest's DI container only ever calls during a REAL
 * NestFactory bootstrap, which this file never does), but because
 * vi.resetModules() + a fresh dynamic import() re-transforms and
 * re-executes this module's entire real dependency graph from scratch -
 * occasionally slow under heavy parallel CI load for ordinary CPU/IO
 * reasons, unrelated to any env value.
 *
 * Fixed by extracting the actual decision - "does MONGODB_URI being set
 * mean DatabaseModule gets imported" - into `ingestionDatabaseImportsFor`,
 * an exported pure function (ingestion.module.ts). Every scenario below
 * that used to need its own dynamic re-import now just calls that function
 * directly with a plain object - no module reset, no re-transform, no
 * import() at all. Only ONE test still needs a real fresh import: the
 * regression guard proving the REAL `@Module` decorator actually uses this
 * function's result (not just that the function itself returns the right
 * thing in isolation) - see docs/learning-notes.md's Stage 9 follow-up for
 * the full investigation and the 30/30 proof this version was validated
 * against.
 */
describe('ingestionDatabaseImportsFor (pure function - no import, no module reset, no network)', () => {
  it('includes DatabaseModule when MONGODB_URI is set', () => {
    expect(ingestionDatabaseImportsFor({ MONGODB_URI: 'mongodb://127.0.0.1:59999/test' })).toEqual([DatabaseModule]);
  });

  it('is empty when MONGODB_URI is unset', () => {
    expect(ingestionDatabaseImportsFor({})).toEqual([]);
  });

  it('is empty when MONGODB_URI is an empty string (it would crash immediately with no real URI)', () => {
    expect(ingestionDatabaseImportsFor({ MONGODB_URI: '' })).toEqual([]);
  });
});

describe('IngestionModule (real, statically-imported class - no dynamic import, no module reset)', () => {
  it('always imports AuthModule and LlmModule, regardless of MONGODB_URI', () => {
    const imports = Reflect.getMetadata('imports', IngestionModule) as unknown[];
    expect(imports).toContain(AuthModule);
    expect(imports).toContain(LlmModule);
  });

  it("the real decorator's imports match exactly what ingestionDatabaseImportsFor(process.env) computes for the ambient env this module was actually loaded under", () => {
    const imports = Reflect.getMetadata('imports', IngestionModule) as unknown[];
    expect(imports).toEqual([AuthModule, LlmModule, ...ingestionDatabaseImportsFor(process.env)]);
  });
});

describe('IngestionModule regression guard (the one case that still needs a real fresh import)', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  // The only scenario the two describe blocks above can't prove on their
  // own: with MONGODB_URI actually set, does the REAL @Module decorator's
  // baked imports array really contain DatabaseModule - not just "does the
  // extracted function return the right array in isolation" (already
  // proven above), but "does the decorator actually use that result".
  // Needs ONE fresh import under a stubbed env the ambient test run
  // doesn't naturally have - vi.resetModules() means the freshly
  // re-imported DatabaseModule is a DIFFERENT class reference than the one
  // statically imported at the top of this file, so this compares the
  // fresh IngestionModule against the fresh DatabaseModule, both from the
  // SAME re-import, never mixing a stale and a fresh reference. Confirmed
  // via the @nestjs/mongoose source reading above that this triggers no
  // real Mongoose connection or DNS lookup - any occasional slowness here
  // would be ordinary module-transform cost, not network timing. No
  // special per-test timeout is needed: validated with 30/30 passes on
  // both an isolated run and 30 repeated FULL-SUITE runs under real
  // parallel load (see docs/learning-notes.md's Stage 9 follow-up).
  it('imports DatabaseModule for real when MONGODB_URI is set (guards against the original bug - removing it from the decorator would fail this test)', async () => {
    // resetModules() BEFORE stubbing/importing, not just after: this file's
    // top-level static import already evaluated and cached ./ingestion.module
    // (under whatever MONGODB_URI the ambient test run has, typically
    // unset) before any test ran. Without clearing that cache first, the
    // dynamic import() below would just return the already-cached module
    // instead of a fresh one that actually sees the stubbed env - exactly
    // the bug this test had on its first version (it was asserting against
    // stale, cached metadata and failing even with entirely correct
    // production code).
    vi.resetModules();
    vi.stubEnv('MONGODB_URI', 'mongodb://127.0.0.1:59999/test');
    const fresh = await import('./ingestion.module');
    const freshDb = await import('../db/database.module');

    const imports = Reflect.getMetadata('imports', fresh.IngestionModule) as unknown[];
    expect(imports).toContain(freshDb.DatabaseModule);
  });
});
