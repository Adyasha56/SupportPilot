/**
 * Stage 6 item 5 - the three "unconfigured" states PROJECT.md's Stage 5
 * entry documents, each needing a DIFFERENTLY booted app (not just
 * different ChatSettings), plus /health passing in all three:
 *  1. No MONGODB_URI at all -> 503 NOT_CONFIGURED, from ApiKeyGuard itself
 *     (before ChatController's own body even runs - confirmed by reading
 *     api-key.guard.ts: it returns this same shape when its API key
 *     repository is @Optional() and absent, which is what "no MONGODB_URI"
 *     actually produces throughout this app - DatabaseModule never provides
 *     any repository at all in that case).
 *  2. A real database but no GEMINI_API_KEY -> 200 escalate LLM_UNAVAILABLE.
 *     LLM_PROVIDER is NEVER overridden in this describe block - the point is
 *     the REAL GeminiLlmProvider (llm.module.ts: "always importable, with or
 *     without GEMINI_API_KEY set"), whose generate() call itself returns the
 *     NOT_CONFIGURED outcome, which run-agent.ts maps to PLAN_LLM_ERROR ->
 *     degraded: LLM_UNAVAILABLE. A ScriptableLlmProvider here would test
 *     nothing real.
 *  3. A real database and a real (dummy, since LLM_PROVIDER IS overridden
 *     here) model key, but no CONNECTOR_CONFIG_DIR -> policy-only: the
 *     planner's allowed-tools list is empty regardless of tenant/identity,
 *     so even a (scripted) model asking for get_order never reaches a real
 *     tool call.
 *
 * isolate: true (vitest.integration.config.mts) means this whole file runs
 * in its own worker process, so deleting/restoring MONGODB_URI/
 * GEMINI_API_KEY here can never leak into any other spec file - but WITHIN
 * this one file/process, the three describe blocks below still run
 * sequentially and restore every env var they touch before the next one's
 * beforeAll, so they never interfere with EACH OTHER either.
 */
import './test-env';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ComposeOutput, PlannerOutput } from '@supportpilot/shared';
import { AppModule } from '../../src/app.module';
import { LLM_PROVIDER } from '../../src/llm/llm.module';
import { GenerateOutcome } from '../../src/llm/llm-provider.interface';
import { AGENT_RUN_REPOSITORY, AgentRunRepository } from '../../src/db/agent-run.repository';
import { cleanupTenant, createTenantFixture, disconnectFixtureConnection } from './tenant-fixture';
import { getTestMongoUri, integrationTestsEnabled } from './test-env';
import { ScriptableLlmProvider, mintCustomerToken, registerCustomerKeyFixture } from './chat-fixtures';

function planOutput(overrides: Partial<PlannerOutput> = {}): GenerateOutcome {
  const data: PlannerOutput = { reasoning: 'thinking', needsPolicy: false, toolRequests: [], ...overrides };
  return { ok: true, result: { text: JSON.stringify(data), usage: { inputTokens: 10, outputTokens: 10 } } };
}

function composeOutput(overrides: Partial<ComposeOutput> = {}): GenerateOutcome {
  const data: ComposeOutput = { outcome: 'clarify', message: 'ok', citedChunkKeys: [], ...overrides };
  return { ok: true, result: { text: JSON.stringify(data), usage: { inputTokens: 10, outputTokens: 10 } } };
}

const realUri = integrationTestsEnabled() ? getTestMongoUri() : '';
const allCreatedTenants: string[] = [];

afterAll(async () => {
  if (!integrationTestsEnabled()) {
    return;
  }
  await Promise.all(allCreatedTenants.map((tenantId) => cleanupTenant(realUri, tenantId)));
  await disconnectFixtureConnection();
});

describe.skipIf(!integrationTestsEnabled())('No MONGODB_URI at all (integration)', () => {
  let app: INestApplication;
  let close: () => Promise<void>;
  let priorMongoUri: string | undefined;

  /**
   * HARNESS BUG, found via a CI failure (ExceptionsHandler showed
   * FakeLlmProvider.generate() being called through
   * ChatService.runLockedPipeline - i.e. the request reached runAgent,
   * meaning the repos were NOT undefined, meaning MONGODB_URI was NOT
   * actually unset from AppModule's point of view): `app.module.ts` (and
   * `auth.module.ts`/`chat.module.ts`/`ingestion.module.ts`/
   * `retrieval.module.ts`) each compute their OWN "import DatabaseModule or
   * not" decision as a plain module-level `const`, read from
   * `process.env.MONGODB_URI` exactly ONCE, the first time that module is
   * ever imported in this process (confirmed by reading app.module.ts:
   * `const databaseImports = process.env.MONGODB_URI ? [DatabaseModule] : [];`
   * at the top level, baked into the `@Module` decorator's metadata at
   * class-definition time - never re-read later). This file's static
   * `import { AppModule } from '../../src/app.module'` at the top already
   * evaluated that line - under the REAL test URI `test-env.ts`'s
   * `wireTestEnv()` setupFile had already set - before this describe
   * block's own `beforeAll` ever got a chance to delete it. Deleting the
   * env var afterward can never un-bake an already-finalized decorator.
   *
   * This exact trap, and its fix, is already documented precedent in this
   * codebase (`ingestion.module.spec.ts`'s own "IngestionModule regression
   * guard" describe block): `vi.resetModules()` clears the module cache so
   * a FRESH `await import(...)` re-evaluates the whole chain (AppModule and
   * every module it transitively imports) under whatever env is set AT
   * THAT MOMENT. The matching `LLM_PROVIDER` symbol must come from the SAME
   * fresh import batch, not the stale one imported at this file's top -
   * `Symbol('LLM_PROVIDER')` is re-evaluated too under resetModules(), so
   * overriding the STALE top-level `LLM_PROVIDER` constant would silently
   * fail to match the fresh module graph's actual DI token.
   */
  beforeAll(async () => {
    priorMongoUri = process.env.MONGODB_URI;
    delete process.env.MONGODB_URI;

    vi.resetModules();
    const freshAppModule = await import('../../src/app.module.js');
    const freshLlmModule = await import('../../src/llm/llm.module.js');

    const moduleRef = await Test.createTestingModule({ imports: [freshAppModule.AppModule] })
      .overrideProvider(freshLlmModule.LLM_PROVIDER)
      .useValue(new ScriptableLlmProvider())
      .compile();
    app = moduleRef.createNestApplication();
    await app.init();
    close = () => app.close();
  }, 150_000);

  afterAll(async () => {
    await close();
    if (priorMongoUri === undefined) {
      delete process.env.MONGODB_URI;
    } else {
      process.env.MONGODB_URI = priorMongoUri;
    }
    // Restores a clean module-cache state before the NEXT describe block's
    // beforeAll runs - that block keeps using this file's own static,
    // top-of-file AppModule/LLM_PROVIDER references (unaffected by this
    // call either way, since resetModules() only governs FUTURE import()
    // cache lookups, never already-held object references), but resetting
    // here keeps this file's env/module state fully symmetric rather than
    // leaving a one-directional special case for whoever reads this later.
    vi.resetModules();
  });

  it('/health still passes with no database at all', async () => {
    const res = await request(app.getHttpServer()).get('/health');
    expect(res.status).toBe(200);
  });

  it('POST /v1/chat returns 503 NOT_CONFIGURED - from ApiKeyGuard itself, since no key lookup is even possible', async () => {
    // Created via a SEPARATE, direct mongoose connection to the real test
    // database (tenant-fixture.ts takes the uri as an explicit parameter,
    // never from process.env) - this fixture helper's own connection is
    // entirely independent of the APP's MONGODB_URI, which is what we just
    // deleted above.
    const tenant = await createTenantFixture(realUri);
    allCreatedTenants.push(tenant.tenantId);

    const res = await request(app.getHttpServer()).post('/v1/chat').set('Authorization', `Bearer ${tenant.publicKey}`).send({ message: 'hi' });

    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({ code: 'NOT_CONFIGURED' });
  });
});

describe.skipIf(!integrationTestsEnabled())('A real database but no GEMINI_API_KEY (integration)', () => {
  let app: INestApplication;
  let close: () => Promise<void>;
  let priorGeminiKey: string | undefined;

  beforeAll(async () => {
    priorGeminiKey = process.env.GEMINI_API_KEY;
    delete process.env.GEMINI_API_KEY;

    // Deliberately NO .overrideProvider(LLM_PROVIDER) here - the real
    // GeminiLlmProvider is what must report NOT_CONFIGURED for generate(),
    // not a test double standing in for it.
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    close = () => app.close();
  }, 150_000);

  afterAll(async () => {
    await close();
    if (priorGeminiKey === undefined) {
      delete process.env.GEMINI_API_KEY;
    } else {
      process.env.GEMINI_API_KEY = priorGeminiKey;
    }
  });

  it('/health still passes with a database but no model key', async () => {
    const res = await request(app.getHttpServer()).get('/health');
    expect(res.status).toBe(200);
  });

  it('POST /v1/chat succeeds at the HTTP layer with outcome escalate and degraded LLM_UNAVAILABLE - never an HTTP error for a model-availability problem', async () => {
    const tenant = await createTenantFixture(realUri);
    allCreatedTenants.push(tenant.tenantId);

    const res = await request(app.getHttpServer()).post('/v1/chat').set('Authorization', `Bearer ${tenant.publicKey}`).send({ message: 'hi' });

    expect(res.status).toBe(200);
    expect(res.body.outcome).toBe('escalate');
    expect(res.body.degraded).toBe('LLM_UNAVAILABLE');

    const agentRunRepository = app.get<AgentRunRepository>(AGENT_RUN_REPOSITORY);
    const runs = await agentRunRepository.findByConversation(tenant.tenantId, res.body.conversationId as string);
    expect(runs[0].degraded).toBe('LLM_UNAVAILABLE');
  });
});

describe.skipIf(!integrationTestsEnabled())('A real database and model key, but no CONNECTOR_CONFIG_DIR (integration)', () => {
  let app: INestApplication;
  let close: () => Promise<void>;
  let scriptableLlm: ScriptableLlmProvider;

  beforeAll(async () => {
    // CONNECTOR_CONFIG_DIR is never set anywhere in this file - this
    // describe block relies on it being genuinely absent in the ambient
    // test environment (true for this project's own .env.example/CI setup;
    // no other integration spec file sets it globally, and isolate: true
    // means no other FILE's own mutation of it could leak in here either).
    expect(process.env.CONNECTOR_CONFIG_DIR, 'this test requires CONNECTOR_CONFIG_DIR to be genuinely unset in the ambient environment').toBeUndefined();

    scriptableLlm = new ScriptableLlmProvider();
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).overrideProvider(LLM_PROVIDER).useValue(scriptableLlm).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    close = () => app.close();
  }, 150_000);

  afterAll(() => close());

  it('/health still passes with no connector directory configured', async () => {
    const res = await request(app.getHttpServer()).get('/health');
    expect(res.status).toBe(200);
  });

  it('a verified customer asking about an order still gets a policy-only answer - no tool call is ever attempted, even though the (scripted) model asks for one', async () => {
    const tenant = await createTenantFixture(realUri);
    allCreatedTenants.push(tenant.tenantId);
    const { kid, privateKey } = await registerCustomerKeyFixture(realUri, tenant.tenantId);
    const token = mintCustomerToken(tenant.tenantId, 'cust_1', kid, privateKey);

    scriptableLlm.setScript([
      planOutput({ toolRequests: [{ tool: 'get_order', order_id: 'ORD-1001' }] }),
      composeOutput({ outcome: 'clarify', message: 'Could you tell me more?' }),
    ]);

    const res = await request(app.getHttpServer()).post('/v1/chat').set('Authorization', `Bearer ${tenant.publicKey}`).send({ message: 'where is my order', customerToken: token });

    expect(res.status).toBe(200);
    expect(res.body.outcome).toBe('clarify');

    const agentRunRepository = app.get<AgentRunRepository>(AGENT_RUN_REPOSITORY);
    const runs = await agentRunRepository.findByConversation(tenant.tenantId, res.body.conversationId as string);
    expect(runs[0].steps.some((s) => s.type === 'tool')).toBe(false);
  });
});
