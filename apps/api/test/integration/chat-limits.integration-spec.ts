/**
 * Stage 6 - rate limits, budget exhaustion, circuit-open, model failure,
 * history/length caps, body/message-size edge cases, and amendment C
 * (mandatory AgentRun persistence for a pending_approval result),
 * against the real database. Each concern gets its OWN app instance,
 * booted with its own tiny env override, so one test's tiny limit can
 * never bleed into another's (the IP/API-key rate limiters in particular
 * hold process-lifetime state with no per-test reset) - same reasoning
 * quota-and-concurrency.integration-spec.ts's own doc comment gives for
 * its two separate apps, just more of them here.
 *
 * None of these scenarios need the mock-store or connector fixtures - every
 * script here either makes zero tool requests or relies on the planner's
 * own structural allow-list filtering (no connectors configured = no tools
 * ever attempted), so this file never calls startMockStore()/
 * writeAcmeConnectorFixtures() at all.
 */
import './test-env';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ComposeOutput, PlannerOutput } from '@supportpilot/shared';
import { AppModule } from '../../src/app.module';
import { LLM_PROVIDER } from '../../src/llm/llm.module';
import { GenerateOutcome } from '../../src/llm/llm-provider.interface';
import { FakeLlmProvider } from '../../src/llm/test-utils/fake-llm-provider';
import { ChatBodyParserErrorFilter } from '../../src/chat/chat-body-parser-error.filter';
import { getModelToken } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import { AGENT_RUN_REPOSITORY, AgentRunRecord, AgentRunRepository, MongooseAgentRunRepository, NewAgentRun } from '../../src/db/agent-run.repository';
import { AgentRunDocument } from '../../src/db/schemas/agent-run.schema';
import { CONVERSATION_REPOSITORY, ConversationRepository } from '../../src/db/conversation.repository';
import { MESSAGE_REPOSITORY, MessageRepository } from '../../src/db/message.repository';
import { cleanupTenant, createApiKeyFixture, createTenantFixture, disconnectFixtureConnection, TenantFixture } from './tenant-fixture';
import { getTestMongoUri, integrationTestsEnabled } from './test-env';
import {
  CONNECTOR_SECRET_ENV_VAR,
  MOCK_STORE_TOKEN,
  MockStoreHandle,
  ScriptableLlmProvider,
  makeTempConnectorRoot,
  mintCustomerToken,
  registerCustomerKeyFixture,
  removeTempConnectorRoot,
  startMockStore,
  writeAcmeConnectorFixtures,
} from './chat-fixtures';

function planOutput(overrides: Partial<PlannerOutput> = {}): GenerateOutcome {
  const data: PlannerOutput = { reasoning: 'thinking', needsPolicy: false, toolRequests: [], ...overrides };
  return { ok: true, result: { text: JSON.stringify(data), usage: { inputTokens: 10, outputTokens: 10 } } };
}

function composeOutput(overrides: Partial<ComposeOutput> = {}): GenerateOutcome {
  const data: ComposeOutput = { outcome: 'clarify', message: 'ok', citedChunkKeys: [], ...overrides };
  return { ok: true, result: { text: JSON.stringify(data), usage: { inputTokens: 10, outputTokens: 10 } } };
}

const uri = integrationTestsEnabled() ? getTestMongoUri() : '';
const allCreatedTenants: string[] = [];

interface Harness {
  app: INestApplication;
  scriptableLlm: ScriptableLlmProvider;
  close(): Promise<void>;
}

/**
 * Boots a fresh AppModule with LLM_PROVIDER replaced by a ScriptableLlmProvider
 * and the given env vars set BEFORE compile() - same requirement as
 * chat.integration-spec.ts's own beforeAll (env read synchronously by each
 * *.settings.ts factory during module compilation, not lazily per-request).
 * Restores every overridden var to its PRIOR value on close() (not just
 * deleting it), so booting several of these in sequence in one file never
 * leaks one test's env into the next one's compile() call.
 */
async function bootChatTestApp(envOverrides: Record<string, string>): Promise<Harness> {
  const prior: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(envOverrides)) {
    prior[key] = process.env[key];
    process.env[key] = value;
  }

  const scriptableLlm = new ScriptableLlmProvider();
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).overrideProvider(LLM_PROVIDER).useValue(scriptableLlm).compile();
  const app = moduleRef.createNestApplication();
  await app.init();

  return {
    app,
    scriptableLlm,
    close: async () => {
      await app.close();
      for (const [key, value] of Object.entries(prior)) {
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
    },
  };
}

async function newTenant(): Promise<TenantFixture> {
  const fixture = await createTenantFixture(uri);
  allCreatedTenants.push(fixture.tenantId);
  return fixture;
}

afterAll(async () => {
  if (!integrationTestsEnabled()) {
    return;
  }
  await Promise.all(allCreatedTenants.map((tenantId) => cleanupTenant(uri, tenantId)));
  await disconnectFixtureConnection();
});

describe.skipIf(!integrationTestsEnabled())('Chat rate limits (integration, real database)', () => {
  describe('per-IP limit (ApiKeyGuard, before any database read)', () => {
    let h: Harness;
    beforeAll(async () => {
      h = await bootChatTestApp({ CHAT_RATE_LIMIT_IP_MAX_REQUESTS: '2', CHAT_RATE_LIMIT_IP_WINDOW_MS: '60000' });
    }, 150_000);
    afterAll(() => h.close());

    it('the 3rd request from the same IP within the window gets the GUARD-level 429 shape, before a tenant even needs resolving', async () => {
      const tenant = await newTenant();
      h.scriptableLlm.setScript([planOutput(), composeOutput()]);
      const ok1 = await request(h.app.getHttpServer()).post('/v1/chat').set('Authorization', `Bearer ${tenant.publicKey}`).send({ message: 'hi' });
      expect(ok1.status).toBe(200);

      h.scriptableLlm.setScript([planOutput(), composeOutput()]);
      const ok2 = await request(h.app.getHttpServer()).post('/v1/chat').set('Authorization', `Bearer ${tenant.publicKey}`).send({ message: 'hi' });
      expect(ok2.status).toBe(200);

      const limited = await request(h.app.getHttpServer()).post('/v1/chat').set('Authorization', `Bearer ${tenant.publicKey}`).send({ message: 'hi' });
      expect(limited.status).toBe(429);
      expect(limited.body).toMatchObject({ code: 'RATE_LIMITED', message: 'Too many requests.' });
      expect(limited.headers['retry-after']).toBeDefined();
    });
  });

  describe('per-API-key limit', () => {
    let h: Harness;
    beforeAll(async () => {
      h = await bootChatTestApp({
        CHAT_RATE_LIMIT_IP_MAX_REQUESTS: '1000',
        CHAT_RATE_LIMIT_API_KEY_MAX_REQUESTS: '2',
        CHAT_RATE_LIMIT_API_KEY_WINDOW_MS: '60000',
        CHAT_RATE_LIMIT_TENANT_MAX_REQUESTS: '1000',
      });
    }, 150_000);
    afterAll(() => h.close());

    it('the 3rd request on the same key gets the GUARD-level 429, even though the tenant limit is nowhere near hit', async () => {
      const tenant = await newTenant();
      for (let i = 0; i < 2; i++) {
        h.scriptableLlm.setScript([planOutput(), composeOutput()]);
        const res = await request(h.app.getHttpServer()).post('/v1/chat').set('Authorization', `Bearer ${tenant.publicKey}`).send({ message: 'hi' });
        expect(res.status).toBe(200);
      }
      const limited = await request(h.app.getHttpServer()).post('/v1/chat').set('Authorization', `Bearer ${tenant.publicKey}`).send({ message: 'hi' });
      expect(limited.status).toBe(429);
      expect(limited.body).toMatchObject({ code: 'RATE_LIMITED', message: 'Too many requests.' });
    });
  });

  describe('per-tenant limit (chat.service.ts, distinct from the per-key guard layer)', () => {
    let h: Harness;
    beforeAll(async () => {
      h = await bootChatTestApp({
        CHAT_RATE_LIMIT_IP_MAX_REQUESTS: '1000',
        CHAT_RATE_LIMIT_API_KEY_MAX_REQUESTS: '1000',
        CHAT_RATE_LIMIT_TENANT_MAX_REQUESTS: '3',
        CHAT_RATE_LIMIT_TENANT_WINDOW_MS: '60000',
        CHAT_RATE_LIMIT_CUSTOMER_REF_MAX_REQUESTS: '1000',
      });
    }, 150_000);
    afterAll(() => h.close());

    it('exceeding the TENANT total (summed across several DIFFERENT keys) gets the SERVICE-level 429, with a tenant-specific message', async () => {
      const tenant = await newTenant();
      const keyB = await createApiKeyFixture(uri, tenant.tenantId, 'public');
      // Exactly CHAT_RATE_LIMIT_TENANT_MAX_REQUESTS (3) successful requests,
      // summed across two DIFFERENT keys - not one more. A 4th request in
      // THIS loop (as an earlier version had) would itself already exceed
      // the tenant limit and get 429 here, failing the "should be 200"
      // assertion below for the wrong reason before the test ever reaches
      // its own dedicated "now exceed it" request.
      const keys = [tenant.publicKey, tenant.publicKey, keyB.rawKey];

      for (const key of keys) {
        h.scriptableLlm.setScript([planOutput(), composeOutput()]);
        const res = await request(h.app.getHttpServer()).post('/v1/chat').set('Authorization', `Bearer ${key}`).send({ message: 'hi' });
        expect(res.status).toBe(200);
      }

      const limited = await request(h.app.getHttpServer()).post('/v1/chat').set('Authorization', `Bearer ${keyB.rawKey}`).send({ message: 'hi' });
      expect(limited.status).toBe(429);
      expect(limited.body).toMatchObject({ code: 'RATE_LIMITED', message: 'Too many requests for this tenant.' });
    });
  });

  describe('per-customerRef limit (narrower than, and on top of, the tenant limit)', () => {
    let h: Harness;
    beforeAll(async () => {
      h = await bootChatTestApp({
        CHAT_RATE_LIMIT_IP_MAX_REQUESTS: '1000',
        CHAT_RATE_LIMIT_API_KEY_MAX_REQUESTS: '1000',
        CHAT_RATE_LIMIT_TENANT_MAX_REQUESTS: '1000',
        CHAT_RATE_LIMIT_CUSTOMER_REF_MAX_REQUESTS: '2',
        CHAT_RATE_LIMIT_CUSTOMER_REF_WINDOW_MS: '60000',
      });
    }, 150_000);
    afterAll(() => h.close());

    it('exceeding the verified customerRef limit gets the SERVICE-level 429, with a customer-specific message', async () => {
      const tenant = await newTenant();
      const { kid, privateKey } = await registerCustomerKeyFixture(uri, tenant.tenantId);
      const token = mintCustomerToken(tenant.tenantId, 'cust_1', kid, privateKey);

      for (let i = 0; i < 2; i++) {
        h.scriptableLlm.setScript([planOutput(), composeOutput()]);
        const res = await request(h.app.getHttpServer()).post('/v1/chat').set('Authorization', `Bearer ${tenant.publicKey}`).send({ message: 'hi', customerToken: token });
        expect(res.status).toBe(200);
      }

      const limited = await request(h.app.getHttpServer())
        .post('/v1/chat')
        .set('Authorization', `Bearer ${tenant.publicKey}`)
        .send({ message: 'hi', customerToken: token });
      expect(limited.status).toBe(429);
      expect(limited.body).toMatchObject({ code: 'RATE_LIMITED', message: 'Too many requests for this customer.' });
    });
  });
});

describe.skipIf(!integrationTestsEnabled())('Chat budgets and model availability (integration, real database)', () => {
  describe('the global, cross-tenant daily generate budget', () => {
    let h: Harness;
    beforeAll(async () => {
      h = await bootChatTestApp({ GEMINI_DAILY_GENERATE_BUDGET: '2' });
    }, 150_000);
    afterAll(() => h.close());

    it('once the shared global budget is exhausted, the NEXT attempt is degraded DAILY_BUDGET_EXCEEDED with zero further provider calls', async () => {
      const tenant = await newTenant();
      // Spends the 2-ticket global budget on one ordinary turn (plan + compose).
      h.scriptableLlm.setScript([planOutput(), composeOutput()]);
      const first = await request(h.app.getHttpServer()).post('/v1/chat').set('Authorization', `Bearer ${tenant.publicKey}`).send({ message: 'hi' });
      expect(first.status).toBe(200);

      h.scriptableLlm.setScript([]);
      const before = h.scriptableLlm.generateCalls;
      const res = await request(h.app.getHttpServer()).post('/v1/chat').set('Authorization', `Bearer ${tenant.publicKey}`).send({ message: 'hi again' });

      expect(res.status).toBe(200);
      expect(res.body.outcome).toBe('escalate');
      expect(res.body.degraded).toBe('DAILY_BUDGET_EXCEEDED');
      expect(h.scriptableLlm.generateCalls).toBe(before);
    });
  });

  describe('the per-tenant daily generate budget (UTC-day reset)', () => {
    let h: Harness;
    beforeAll(async () => {
      h = await bootChatTestApp({ CHAT_TENANT_DAILY_GENERATE_BUDGET: '2' });
    }, 150_000);
    afterAll(() => h.close());

    it('once THIS tenant\'s own budget is exhausted, it degrades TENANT_BUDGET_EXCEEDED - checked before the shared global layer', async () => {
      const tenant = await newTenant();
      h.scriptableLlm.setScript([planOutput(), composeOutput()]);
      const first = await request(h.app.getHttpServer()).post('/v1/chat').set('Authorization', `Bearer ${tenant.publicKey}`).send({ message: 'hi' });
      expect(first.status).toBe(200);

      h.scriptableLlm.setScript([]);
      const before = h.scriptableLlm.generateCalls;
      const res = await request(h.app.getHttpServer()).post('/v1/chat').set('Authorization', `Bearer ${tenant.publicKey}`).send({ message: 'hi again' });

      expect(res.status).toBe(200);
      expect(res.body.degraded).toBe('TENANT_BUDGET_EXCEEDED');
      expect(h.scriptableLlm.generateCalls).toBe(before);
    });
  });

  describe('circuit-open and model-failure (plain script control, no special settings needed)', () => {
    let h: Harness;
    beforeAll(async () => {
      h = await bootChatTestApp({});
    }, 150_000);
    afterAll(() => h.close());

    it('the provider itself reporting CIRCUIT_OPEN degrades the run to CIRCUIT_OPEN, never retried', async () => {
      const tenant = await newTenant();
      h.scriptableLlm.setScript([{ ok: false, error: { code: 'CIRCUIT_OPEN', message: 'breaker open' } }]);

      const res = await request(h.app.getHttpServer()).post('/v1/chat').set('Authorization', `Bearer ${tenant.publicKey}`).send({ message: 'hi' });

      expect(res.status).toBe(200);
      expect(res.body.outcome).toBe('escalate');
      expect(res.body.degraded).toBe('CIRCUIT_OPEN');
      expect(h.scriptableLlm.generateCalls).toBe(1);
    });

    it('a non-retryable provider failure (UNAUTHORIZED) degrades the run to LLM_UNAVAILABLE', async () => {
      const tenant = await newTenant();
      h.scriptableLlm.setScript([{ ok: false, error: { code: 'UNAUTHORIZED', message: 'bad key' } }]);

      const res = await request(h.app.getHttpServer()).post('/v1/chat').set('Authorization', `Bearer ${tenant.publicKey}`).send({ message: 'hi' });

      expect(res.status).toBe(200);
      expect(res.body.outcome).toBe('escalate');
      expect(res.body.degraded).toBe('LLM_UNAVAILABLE');
    });
  });

  describe('body size and malformed JSON, against the REAL global filter wiring (main.ts), not a standalone test module', () => {
    let app: INestApplication;
    let close: () => Promise<void>;

    beforeAll(async () => {
      const scriptableLlm = new ScriptableLlmProvider();
      const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).overrideProvider(LLM_PROVIDER).useValue(scriptableLlm).compile();
      app = moduleRef.createNestApplication();
      // main.ts installs ChatBodyParserErrorFilter globally BEFORE listening -
      // this TestingModule path (createNestApplication(), no main.ts
      // bootstrap function involved) does not replicate that on its own, so
      // this describe block's whole point - proving the filter in
      // chat-body-parser-error.filter.spec.ts is actually wired into a REAL
      // boot, not just a standalone test module - needs the same
      // registration main.ts performs, done here BEFORE init() (a filter
      // registered after init() would miss requests the body-parser
      // middleware itself already rejected during bootstrap).
      app.useGlobalFilters(new ChatBodyParserErrorFilter(app.getHttpAdapter()));
      await app.init();
      close = () => app.close();
    }, 150_000);
    afterAll(() => close());

    it('an oversized body is rejected with this project\'s own shape, never the default body-parser shape', async () => {
      const tenant = await newTenant();
      const res = await request(app.getHttpServer())
        .post('/v1/chat')
        .set('Authorization', `Bearer ${tenant.publicKey}`)
        .send({ message: 'x'.repeat(200_000) });
      expect(res.status).toBe(413);
      expect(res.body).toHaveProperty('code');
    });

    it('malformed JSON is rejected with this project\'s own shape', async () => {
      const tenant = await newTenant();
      const res = await request(app.getHttpServer())
        .post('/v1/chat')
        .set('Authorization', `Bearer ${tenant.publicKey}`)
        .set('Content-Type', 'application/json')
        .send('{not valid json');
      expect(res.status).toBe(400);
      expect(res.body).toHaveProperty('code');
    });

    it('a message over ChatRequestSchema\'s own 4000-char cap is a plain 400 INVALID_REQUEST (schema-level, not the body-parser filter)', async () => {
      const tenant = await newTenant();
      const res = await request(app.getHttpServer())
        .post('/v1/chat')
        .set('Authorization', `Bearer ${tenant.publicKey}`)
        .send({ message: 'x'.repeat(4001) });
      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ code: 'INVALID_REQUEST' });
    });
  });
});

describe.skipIf(!integrationTestsEnabled())('Chat history window and char cap (integration, real database)', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await bootChatTestApp({
      CHAT_HISTORY_WINDOW_SIZE: '2',
      CHAT_HISTORY_MAX_CHARS: '40',
      // Deliberately generous, NOT the tiny value the neighboring
      // "conversation length cap" describe block needs - a real bug here
      // (CI, not just reasoning about it): both tests used to share ONE
      // app with CHAT_MAX_MESSAGES_PER_CONVERSATION=4, sized for the OTHER
      // test. This test's own 3 turns legitimately hit THAT cap on its own
      // 3rd request (messageCount 0->2->4, then 4+2=6 > 4), getting a real
      // 409 CONVERSATION_LENGTH_EXCEEDED where the test expected 200 - not
      // a lock, not a leftover from another test, just one app's setting
      // sized for a different test's own scenario. Each concern now gets
      // its own app instance, same pattern every other describe block in
      // this file already follows.
      CHAT_MAX_MESSAGES_PER_CONVERSATION: '100',
    });
  }, 150_000);
  afterAll(() => h.close());

  interface CapturedCall {
    systemInstruction: string;
    messages: { role: string; text: string }[];
  }

  /** Records every generate() call's raw options (what the "model" actually received) alongside delegating to a plain FakeLlmProvider for the scripted response - used to prove the history window/char cap actually shrank what reached the compose call, not just what got stored. */
  class CapturingLlmProvider extends FakeLlmProvider {
    readonly calls: CapturedCall[] = [];

    async generate(options: Parameters<FakeLlmProvider['generate']>[0]): ReturnType<FakeLlmProvider['generate']> {
      this.calls.push({ systemInstruction: options.systemInstruction, messages: options.messages });
      return super.generate(options);
    }
  }

  function capturingProvider(script: GenerateOutcome[]): { provider: CapturingLlmProvider; calls: CapturedCall[] } {
    const provider = new CapturingLlmProvider(script);
    return { provider, calls: provider.calls };
  }

  it('the history window + char cap trims old turns out of what reaches the compose call, while every turn is still fully persisted', async () => {
    const tenant = await newTenant();
    const { kid, privateKey } = await registerCustomerKeyFixture(uri, tenant.tenantId);
    const token = mintCustomerToken(tenant.tenantId, 'cust_hist', kid, privateKey);

    // Three real turns, all threaded onto the SAME conversation by explicitly
    // passing conversationId from the first response into every later
    // request. Without this, each request (none of them originally carried
    // a conversationId) silently starts its OWN brand new conversation -
    // resolveConversation() only ever reuses an existing one when the
    // caller names it (chat.service.ts) - so the "first turn" would never
    // actually be IN the conversation this test later inspects at all, a
    // real bug in this test rather than evidence of windowing.
    h.scriptableLlm.setScript([planOutput(), composeOutput({ outcome: 'clarify', message: 'reply 0' })]);
    const firstRes = await request(h.app.getHttpServer())
      .post('/v1/chat')
      .set('Authorization', `Bearer ${tenant.publicKey}`)
      .send({ message: 'FIRST_TURN_MARKER_AAA', customerToken: token });
    expect(firstRes.status).toBe(200);
    const conversationId = firstRes.body.conversationId as string;

    // historyWindowSize=2 means only the most recent 2 STORED messages (one
    // prior turn's worth) are ever loaded for the 3rd request - the
    // far-older first turn's text must never reach it.
    h.scriptableLlm.setScript([planOutput(), composeOutput({ outcome: 'clarify', message: 'reply 1' })]);
    const secondRes = await request(h.app.getHttpServer())
      .post('/v1/chat')
      .set('Authorization', `Bearer ${tenant.publicKey}`)
      .send({ message: 'SECOND_TURN_MARKER_BBB', conversationId, customerToken: token });
    expect(secondRes.status).toBe(200);

    const { provider, calls } = capturingProvider([planOutput(), composeOutput({ outcome: 'clarify', message: 'third reply' })]);
    h.scriptableLlm.setProvider(provider);
    const res = await request(h.app.getHttpServer())
      .post('/v1/chat')
      .set('Authorization', `Bearer ${tenant.publicKey}`)
      .send({ message: 'THIRD_TURN_MARKER_CCC', conversationId, customerToken: token });
    expect(res.status, `expected 200, got ${res.status} with body ${JSON.stringify(res.body)}`).toBe(200);
    expect(res.body.conversationId).toBe(conversationId);

    const composeCallContent = calls[1].messages.map((m) => m.text).join('\n');
    expect(composeCallContent).not.toContain('FIRST_TURN_MARKER_AAA');

    // findRecentForConversation is deliberately WINDOWED (bounded by the
    // limit argument, same contract HistoryTurn[] relies on) - asserting
    // "nothing was actually deleted from storage" needs an UNBOUNDED read
    // instead, direct against the raw collection, not the windowed
    // repository method whose whole job is to return less than everything.
    const messageModel = h.app.get<Model<unknown>>(getModelToken('Message'));
    const allStored = await messageModel.collection.find({ tenantId: tenant.tenantId, conversationId }).toArray();
    expect(allStored).toHaveLength(6); // 3 turns x (customer message + agent reply)
    expect(allStored.some((m) => (m as unknown as { content: string }).content === 'FIRST_TURN_MARKER_AAA')).toBe(true);
  });
});

describe.skipIf(!integrationTestsEnabled())('Chat conversation length cap (integration, real database)', () => {
  let h: Harness;
  beforeAll(async () => {
    // Its OWN app, deliberately separate from the history-window describe
    // block above - this is the test that actually needs a tiny
    // CHAT_MAX_MESSAGES_PER_CONVERSATION; history/char-cap settings are
    // left at their generous defaults since this test doesn't exercise them.
    h = await bootChatTestApp({ CHAT_MAX_MESSAGES_PER_CONVERSATION: '4' });
  }, 150_000);
  afterAll(() => h.close());

  it('a conversation at its configured message-count ceiling gets 409 CONVERSATION_LENGTH_EXCEEDED before runAgent ever runs', async () => {
    const tenant = await newTenant();
    const conversationRepo = h.app.get<ConversationRepository>(CONVERSATION_REPOSITORY);
    const conversation = await conversationRepo.create(tenant.tenantId, null);
    // maxMessagesPerConversation=4; a turn adds 2 - starting at messageCount
    // 4 means the NEXT turn's +2 would exceed it.
    await conversationRepo.incrementMessageCount(tenant.tenantId, conversation.id, 4);

    h.scriptableLlm.setScript([]);
    const before = h.scriptableLlm.generateCalls;
    const res = await request(h.app.getHttpServer())
      .post('/v1/chat')
      .set('Authorization', `Bearer ${tenant.publicKey}`)
      .send({ message: 'hi', conversationId: conversation.id });

    expect(res.status, `expected 409, got ${res.status} with body ${JSON.stringify(res.body)}`).toBe(409);
    expect(res.body).toMatchObject({ code: 'CONVERSATION_LENGTH_EXCEEDED' });
    expect(h.scriptableLlm.generateCalls).toBe(before);
  });
});

/**
 * Wraps the REAL MongooseAgentRunRepository (constructed from the real
 * injected Mongoose Model, the exact way agent-run.repository.ts's own
 * provider does) and makes ONLY create() always fail - findByConversation
 * and deleteForTenant still hit the real database. This is the "repository
 * WRAPPER over the real one" the Stage 6 brief asks for, never a full-DB
 * mock: every other collection in this test is the real thing.
 */
class FailingCreateAgentRunRepository implements AgentRunRepository {
  constructor(private readonly real: AgentRunRepository) {}
  create(_run: NewAgentRun): Promise<AgentRunRecord> {
    return Promise.reject(new Error('simulated AgentRun persistence failure'));
  }
  findByConversation(tenantId: string, conversationId: string): Promise<AgentRunRecord[]> {
    return this.real.findByConversation(tenantId, conversationId);
  }
  deleteForTenant(tenantId: string): Promise<void> {
    return this.real.deleteForTenant(tenantId);
  }
}

describe.skipIf(!integrationTestsEnabled())('Chat amendment C: mandatory AgentRun persistence for pending_approval (integration, real database)', () => {
  let app: INestApplication;
  let scriptableLlm: ScriptableLlmProvider;
  let mockStore: MockStoreHandle;
  let tempConnectorRoot: string;
  let close: () => Promise<void>;

  beforeAll(async () => {
    mockStore = await startMockStore();
    tempConnectorRoot = await makeTempConnectorRoot();
    process.env.NODE_ENV = 'test';
    process.env.ALLOW_PRIVATE_NETWORKS = 'true';
    process.env.CONNECTOR_HOST_ALLOWLIST = `127.0.0.1:${new URL(mockStore.baseUrl).port}`;
    process.env.CONNECTOR_CONFIG_DIR = tempConnectorRoot;
    process.env[CONNECTOR_SECRET_ENV_VAR] = MOCK_STORE_TOKEN;

    scriptableLlm = new ScriptableLlmProvider();
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(LLM_PROVIDER)
      .useValue(scriptableLlm)
      .overrideProvider(AGENT_RUN_REPOSITORY)
      .useFactory({
        inject: [getModelToken('AgentRun')],
        factory: (model: Model<AgentRunDocument>) => new FailingCreateAgentRunRepository(new MongooseAgentRunRepository(model)),
      })
      .compile();
    app = moduleRef.createNestApplication();
    await app.init();
    close = async () => {
      await app.close();
      delete process.env.ALLOW_PRIVATE_NETWORKS;
      delete process.env.CONNECTOR_HOST_ALLOWLIST;
      delete process.env.CONNECTOR_CONFIG_DIR;
      delete process.env[CONNECTOR_SECRET_ENV_VAR];
      await mockStore.close();
      await removeTempConnectorRoot(tempConnectorRoot);
    };
  }, 150_000);
  afterAll(() => close());

  it('a pending_approval result whose AgentRun write fails (even after the one retry) returns 503 and NO proposal at all - never a silent "success" the admin console can never see', async () => {
    const tenant = await newTenant();
    await writeAcmeConnectorFixtures(tempConnectorRoot, tenant.tenantId, mockStore.baseUrl);
    const { kid, privateKey } = await registerCustomerKeyFixture(uri, tenant.tenantId);
    const token = mintCustomerToken(tenant.tenantId, 'cust_2', kid, privateKey);

    // ORD-1003 (cust_2, status delayed, $32.00, no prior refund) - a real
    // get_order call makes this a GENUINELY validated proposal (code-built
    // from real facts, not a bare model claim), so it really does reach
    // persistRunAndRespond's mandatory branch, not just the best-effort one.
    scriptableLlm.setScript([
      planOutput({ toolRequests: [{ tool: 'get_order', order_id: 'ORD-1003' }] }),
      composeOutput({ outcome: 'propose_refund', message: 'Refunding you.', citedChunkKeys: [], proposedRefund: { order_id: 'ORD-1003', amount: 10 } }),
    ]);

    const res = await request(app.getHttpServer()).post('/v1/chat').set('Authorization', `Bearer ${tenant.publicKey}`).send({ message: 'refund me', customerToken: token });

    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({ code: 'PENDING_APPROVAL_WRITE_FAILED' });
    expect(res.body).not.toHaveProperty('proposedAction');

    // The error response carries no conversationId (chatHttpError never
    // includes one) - found instead via the raw model, since this tenant
    // created exactly one conversation in this test. The customer message
    // (persisted BEFORE runAgent, step 10) still exists; only the
    // run/agent-message/count writes that depend on the (failing) AgentRun
    // write never happen for this mandatory case.
    const conversationModel = app.get<Model<unknown>>(getModelToken('Conversation'));
    const conversationDoc = await conversationModel.collection.findOne({ tenantId: tenant.tenantId });
    expect(conversationDoc).not.toBeNull();
    const conversationId = (conversationDoc as unknown as { _id: string })._id;

    const messageRepo = app.get<MessageRepository>(MESSAGE_REPOSITORY);
    const stored = await messageRepo.findRecentForConversation(tenant.tenantId, conversationId, 10);
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ role: 'customer', content: 'refund me' });
  });
});
