import 'reflect-metadata';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ChatModule, chatDatabaseImportsFor } from './chat.module';
import { DatabaseModule } from '../db/database.module';
import { LlmModule } from '../llm/llm.module';
import { RetrievalModule } from '../retrieval/retrieval.module';
import { ToolRunnerModule } from '../agent/tool-runner/tool-runner.module';
import { ConnectorsModule } from '../connectors/connectors.module';
import { ApprovalsModule } from '../approvals/approvals.module';
import { AuthModule } from '../auth/auth.module';

/**
 * Same pure-function pattern (and the same reasoning for it) as
 * ingestion.module.spec.ts's own chatDatabaseImportsFor equivalent - see
 * that file's doc comment for the real bug this guards against (a module
 * that doesn't import DatabaseModule itself never sees its tokens, even
 * when a sibling module in the same AppModule does) and why a dynamically
 * re-imported module is reserved for exactly one regression-guard test,
 * never the everyday scenarios.
 */
describe('chatDatabaseImportsFor (pure function - no import, no module reset, no network)', () => {
  it('includes DatabaseModule when MONGODB_URI is set', () => {
    expect(chatDatabaseImportsFor({ MONGODB_URI: 'mongodb://127.0.0.1:59999/test' })).toEqual([DatabaseModule]);
  });

  it('is empty when MONGODB_URI is unset', () => {
    expect(chatDatabaseImportsFor({})).toEqual([]);
  });

  it('is empty when MONGODB_URI is an empty string', () => {
    expect(chatDatabaseImportsFor({ MONGODB_URI: '' })).toEqual([]);
  });
});

describe('ChatModule (real, statically-imported class - no dynamic import, no module reset)', () => {
  it('always imports LlmModule, RetrievalModule, ToolRunnerModule, ConnectorsModule, and ApprovalsModule, regardless of MONGODB_URI', () => {
    const imports = Reflect.getMetadata('imports', ChatModule) as unknown[];
    expect(imports).toContain(LlmModule);
    expect(imports).toContain(RetrievalModule);
    expect(imports).toContain(ToolRunnerModule);
    expect(imports).toContain(ConnectorsModule);
    expect(imports).toContain(ApprovalsModule);
  });

  it("the real decorator's imports match exactly what chatDatabaseImportsFor(process.env) computes for the ambient env this module was actually loaded under", () => {
    const imports = Reflect.getMetadata('imports', ChatModule) as unknown[];
    expect(imports).toEqual([LlmModule, RetrievalModule, ToolRunnerModule, ConnectorsModule, ApprovalsModule, ...chatDatabaseImportsFor(process.env)]);
  });

  it('never imports AuthModule - it provides its own ApiKeyGuard scoped to this route (see chat-api-key-guard-settings.provider.ts)', () => {
    const imports = Reflect.getMetadata('imports', ChatModule) as unknown[];
    expect(imports).not.toContain(AuthModule);
  });
});

describe('ChatModule regression guard (the one case that still needs a real fresh import)', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('imports DatabaseModule for real when MONGODB_URI is set (removing it from the decorator would fail this test)', async () => {
    vi.resetModules();
    vi.stubEnv('MONGODB_URI', 'mongodb://127.0.0.1:59999/test');
    const fresh = await import('./chat.module.js');
    const freshDb = await import('../db/database.module.js');

    const imports = Reflect.getMetadata('imports', fresh.ChatModule) as unknown[];
    expect(imports).toContain(freshDb.DatabaseModule);
  });
});
