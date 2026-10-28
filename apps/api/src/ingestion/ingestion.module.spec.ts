import 'reflect-metadata';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * A real NestJS bug, caught only by running the real server against a real
 * .env, not by any unit or controller test: IngestionModule never imported
 * DatabaseModule itself, so PoliciesController/PolicyIngestionService's
 * @Optional() repository tokens silently resolved to undefined even with
 * MONGODB_URI set - Nest module providers aren't visible across sibling
 * imports just because they share a parent (AppModule). The
 * controller-level tests never caught this because they hand-provide
 * repositories directly, bypassing this exact import graph. This test
 * inspects IngestionModule's own @Module metadata directly, so a future
 * regression here fails fast instead of only surfacing against a real
 * database at runtime.
 */
describe('IngestionModule', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('imports DatabaseModule when MONGODB_URI is set', async () => {
    vi.stubEnv('MONGODB_URI', 'mongodb://example.invalid/test');
    const { IngestionModule } = await import('./ingestion.module');
    const { DatabaseModule } = await import('../db/database.module');

    const imports = Reflect.getMetadata('imports', IngestionModule) as unknown[];
    expect(imports).toContain(DatabaseModule);
  });

  it('does not import DatabaseModule when MONGODB_URI is unset (it would crash immediately with no URI)', async () => {
    vi.stubEnv('MONGODB_URI', '');
    const { IngestionModule } = await import('./ingestion.module');
    const { DatabaseModule } = await import('../db/database.module');

    const imports = Reflect.getMetadata('imports', IngestionModule) as unknown[];
    expect(imports).not.toContain(DatabaseModule);
  });

  it('always imports AuthModule and LlmModule, regardless of MONGODB_URI', async () => {
    vi.stubEnv('MONGODB_URI', '');
    const { IngestionModule } = await import('./ingestion.module');
    const { AuthModule } = await import('../auth/auth.module');
    const { LlmModule } = await import('../llm/llm.module');

    const imports = Reflect.getMetadata('imports', IngestionModule) as unknown[];
    expect(imports).toContain(AuthModule);
    expect(imports).toContain(LlmModule);
  });
});
