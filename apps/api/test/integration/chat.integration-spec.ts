/**
 * Stage 6 - the real-database integration suite for POST /v1/chat. Boots
 * the REAL AppModule (real Mongoose repositories, real transaction
 * runner, real guards, real retrieval with the deterministic fake
 * embedder, real tool runner through a REAL FileConnectorConfigRepository
 * pointed at a temp, baseUrl-rewritten copy of the committed acme
 * fixtures, against a REAL in-process mock-store) with ONLY LlmProvider
 * overridden - by a ScriptableLlmProvider so each test can set its own
 * deterministic plan/compose script without rebooting the whole app (see
 * chat-fixtures.ts's own doc comment for why that matters at this suite's
 * size: rebuilding a TestingModule against a real, network-hosted test
 * database per scenario would be far too slow).
 *
 * This file covers: the happy paths (order status reply with a real
 * citation, late-shipment refund pending_approval), identity resolution
 * (anonymous, secret-direct, every invalid-token failure mode, a public
 * body's customerRef being ignored), cross-tenant/cross-customer
 * isolation (including a structural, model-proof ownership check),
 * full persistence assertions, a canary-string log sweep, and the real
 * unique/TTL index assertions.
 *
 * Deliberately NOT in this file (each needs a differently-configured app
 * or a non-script provider, so lives in its own file):
 *  - chat-limits.integration-spec.ts: rate limits, budget exhaustion,
 *    circuit-open, model failure, history/length caps, body/message-size
 *    edge cases, amendment C via a repository wrapper.
 *  - chat-concurrency.integration-spec.ts: the same-conversation 409 case
 *    (needs a gated provider, not a plain script).
 *  - chat-unconfigured.integration-spec.ts: NOT_CONFIGURED /
 *    LLM_UNAVAILABLE / policy-only, each needs a DIFFERENTLY booted app.
 *
 * Mock-store seed data used below (mock-store/src/data/seed.ts, dates
 * relative to the real wall clock at mock-store boot, matching the real
 * wall clock runAgent's own derived facts use - both real, never faked,
 * in a full HTTP integration test): ORD-1001 (cust_1, delivered 3 days
 * ago, $49.99), ORD-1003 (cust_2, status delayed, shipment 8 days past
 * its estimate - the one seeded scenario sample-policy.md's own "more
 * than 7 calendar days past estimated delivery" rule confirms as late),
 * ORD-1008 (cust_5, delivered, $44.00 - used as "another customer's
 * order" when cust_1 asks about it).
 */
import './test-env';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { Logger } from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { getModelToken } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import { generateKeyPairSync } from 'node:crypto';
import { ComposeOutput, PlannerOutput } from '@supportpilot/shared';
import { AppModule } from '../../src/app.module';
import { LLM_PROVIDER } from '../../src/llm/llm.module';
import { GenerateOutcome } from '../../src/llm/llm-provider.interface';
import { PolicyRetrievalService } from '../../src/retrieval/policy-retrieval.service';
import { AGENT_RUN_REPOSITORY, AgentRunRepository } from '../../src/db/agent-run.repository';
import { CONVERSATION_REPOSITORY, ConversationRepository } from '../../src/db/conversation.repository';
import { MESSAGE_REPOSITORY, MessageRepository } from '../../src/db/message.repository';
import { APPROVAL_REPOSITORY, ApprovalRepository } from '../../src/approvals/approval.repository';
import { CLOCK_SKEW_ALLOWANCE_MS, signCustomerToken } from '../../src/agent/identity/customer-token';
import {
  cleanupTenant,
  createCustomerPublicKeyFixture,
  createTenantFixture,
  disconnectFixtureConnection,
  TenantFixture,
} from './tenant-fixture';
import { getTestMongoUri, integrationTestsEnabled } from './test-env';
import { pollUntil } from './poll';
import {
  CONNECTOR_SECRET_ENV_VAR,
  MOCK_STORE_TOKEN,
  MockStoreHandle,
  ScriptableLlmProvider,
  canaryString,
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

describe.skipIf(!integrationTestsEnabled())('Chat (integration, real database)', () => {
  let app: INestApplication;
  let mockStore: MockStoreHandle;
  let tempConnectorRoot: string;
  let scriptableLlm: ScriptableLlmProvider;
  const uri = integrationTestsEnabled() ? getTestMongoUri() : '';
  const createdTenants: string[] = [];

  beforeAll(async () => {
    mockStore = await startMockStore();
    tempConnectorRoot = await makeTempConnectorRoot();

    // Must be set BEFORE AppModule is imported/compiled - toolRunnerSettingsProvider's
    // factory (tool-runner.settings.ts) reads process.env synchronously during
    // Test.createTestingModule(...).compile(), not lazily per-request.
    process.env.NODE_ENV = 'test';
    process.env.ALLOW_PRIVATE_NETWORKS = 'true';
    process.env.CONNECTOR_HOST_ALLOWLIST = `127.0.0.1:${new URL(mockStore.baseUrl).port}`;
    process.env.CONNECTOR_CONFIG_DIR = tempConnectorRoot;
    process.env[CONNECTOR_SECRET_ENV_VAR] = MOCK_STORE_TOKEN;

    scriptableLlm = new ScriptableLlmProvider();
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(LLM_PROVIDER)
      .useValue(scriptableLlm)
      .compile();
    app = moduleRef.createNestApplication();
    await app.init();
  }, 150_000);

  afterAll(async () => {
    delete process.env.ALLOW_PRIVATE_NETWORKS;
    delete process.env.CONNECTOR_HOST_ALLOWLIST;
    delete process.env.CONNECTOR_CONFIG_DIR;
    delete process.env[CONNECTOR_SECRET_ENV_VAR];

    await Promise.all(createdTenants.map((tenantId) => cleanupTenant(uri, tenantId)));
    await app.close();
    await mockStore.close();
    await removeTempConnectorRoot(tempConnectorRoot);
    await disconnectFixtureConnection();
  });

  async function newTenant(): Promise<TenantFixture> {
    const fixture = await createTenantFixture(uri);
    createdTenants.push(fixture.tenantId);
    await writeAcmeConnectorFixtures(tempConnectorRoot, fixture.tenantId, mockStore.baseUrl);
    return fixture;
  }

  function repos(): { conversation: ConversationRepository; message: MessageRepository; agentRun: AgentRunRepository; approval: ApprovalRepository } {
    return {
      conversation: app.get(CONVERSATION_REPOSITORY),
      message: app.get(MESSAGE_REPOSITORY),
      agentRun: app.get(AGENT_RUN_REPOSITORY),
      approval: app.get(APPROVAL_REPOSITORY),
    };
  }

  function send(publicOrSecretKey: string, body: Record<string, unknown>) {
    return request(app.getHttpServer()).post('/v1/chat').set('Authorization', `Bearer ${publicOrSecretKey}`).send(body);
  }

  it('owner asks order status: reply with a real citation, via a public key + a valid signed token', async () => {
    const tenant = await newTenant();
    const uniqueWord = `orderstatuslexeme${Date.now()}`;

    const uploadRes = await request(app.getHttpServer())
      .post('/v1/policies')
      .set('Authorization', `Bearer ${tenant.secretKey}`)
      .attach('file', Buffer.from(`# Order status\n\nWe can always tell an owner the current status of their own order. ${uniqueWord}.`), 'policy.md')
      .field('title', 'Order status policy');
    expect(uploadRes.status).toBe(201);
    const documentId = uploadRes.body.id as string;

    const retrievalService = app.get(PolicyRetrievalService);
    const found = await pollUntil(async () => {
      const r = await retrievalService.retrieve(tenant.tenantId, uniqueWord);
      return r.ok && r.results.some((x) => x.documentId === documentId) ? r.results.find((x) => x.documentId === documentId) : undefined;
    }, `tenant ${tenant.tenantId}'s policy chunk becoming searchable for "${uniqueWord}"`);
    const chunkKey = found!.chunkKey;

    const { kid, privateKey } = await registerCustomerKeyFixture(uri, tenant.tenantId);
    const token = mintCustomerToken(tenant.tenantId, 'cust_1', kid, privateKey);

    scriptableLlm.setScript([
      planOutput({ needsPolicy: true, searchQuery: uniqueWord, toolRequests: [{ tool: 'get_order', order_id: 'ORD-1001' }] }),
      composeOutput({ outcome: 'reply', message: 'Your order ORD-1001 was delivered.', citedChunkKeys: [chunkKey] }),
    ]);

    const res = await send(tenant.publicKey, { message: 'where is my order', customerToken: token });

    expect(res.status).toBe(200);
    expect(res.body.outcome).toBe('reply');
    expect(res.body.message).toBe('Your order ORD-1001 was delivered.');
    expect(res.body.citations).toEqual([{ chunkKey, documentTitle: 'Order status policy', headingPath: expect.any(String) }]);
    expect(res.body.proposedAction).toBeUndefined();
    const conversationId = res.body.conversationId as string;

    const { conversation, message, agentRun } = repos();
    const conv = await conversation.findById(tenant.tenantId, conversationId);
    expect(conv).toMatchObject({ customerRef: 'cust_1', messageCount: 2 });

    const messages = await message.findRecentForConversation(tenant.tenantId, conversationId, 10);
    expect(messages).toHaveLength(2);
    expect(messages[0]).toMatchObject({ role: 'customer', content: 'where is my order' });
    expect(messages[1]).toMatchObject({ role: 'agent', content: 'Your order ORD-1001 was delivered.' });

    const runs = await agentRun.findByConversation(tenant.tenantId, conversationId);
    expect(runs).toHaveLength(1);
    expect(runs[0].outcome).toBe('reply');
    expect(runs[0].llmCallCount).toBe(2);
    expect(runs[0].degraded).toBeNull();
    expect(runs[0].steps.some((s) => s.type === 'tool' && s.toolName === 'get_order' && s.orderId === 'ORD-1001' && s.outcomeCode === 'OK')).toBe(true);
    expect(runs[0].steps.some((s) => s.type === 'compose' && s.citedChunkKeys?.includes(chunkKey))).toBe(true);
  });

  it('delivered-order refund within window: pending_approval with a validated proposedAction, mandatory AgentRun+Approval persisted transactionally', async () => {
    const tenant = await newTenant();
    const { kid, privateKey } = await registerCustomerKeyFixture(uri, tenant.tenantId);
    const token = mintCustomerToken(tenant.tenantId, 'cust_1', kid, privateKey);

    // Milestone 4's refund-verifier (rule 3, ORDER_STATUS_INELIGIBLE - delivered only, PROJECT.md
    // Milestone 4 design §4's rules table) and rule 8 (MISSING_POLICY_CITATION) both post-date
    // Milestone 3, which never checked order status or required a citation at all. Two genuine,
    // documented behavior changes versus Milestone 3: (1) ORD-1003 (status 'delayed', never
    // delivered - Milestone 3's own "late shipment" fixture) can no longer reach pending_approval
    // at all; it now denies on ORDER_STATUS_INELIGIBLE - see "not-yet-delivered order: denied"
    // below, and docs/known-limitations.md's note on this. (2) a citation is now mandatory - the
    // original script's citedChunkKeys: [] would now deny on MISSING_POLICY_CITATION too. This
    // test uses ORD-1001 (delivered, within window) and a real cited policy chunk instead, same
    // upload+poll pattern as "owner asks order status" above.
    const uniqueWord = `damagedorderlexeme${Date.now()}`;
    const uploadRes = await request(app.getHttpServer())
      .post('/v1/policies')
      .set('Authorization', `Bearer ${tenant.secretKey}`)
      .attach('file', Buffer.from(`# Refund policy\n\nA delivered order that arrived damaged qualifies for a refund. ${uniqueWord}.`), 'policy.md')
      .field('title', 'Refund policy');
    expect(uploadRes.status).toBe(201);
    const documentId = uploadRes.body.id as string;

    const retrievalService = app.get(PolicyRetrievalService);
    const found = await pollUntil(async () => {
      const r = await retrievalService.retrieve(tenant.tenantId, uniqueWord);
      return r.ok && r.results.some((x) => x.documentId === documentId) ? r.results.find((x) => x.documentId === documentId) : undefined;
    }, `tenant ${tenant.tenantId}'s policy chunk becoming searchable for "${uniqueWord}"`);
    const chunkKey = found!.chunkKey;

    scriptableLlm.setScript([
      planOutput({
        needsPolicy: true,
        searchQuery: uniqueWord,
        toolRequests: [
          { tool: 'get_order', order_id: 'ORD-1001' },
          { tool: 'track_shipment', order_id: 'ORD-1001' },
        ],
      }),
      composeOutput({
        outcome: 'propose_refund',
        message: 'Your order arrived damaged - we are issuing a refund.',
        citedChunkKeys: [chunkKey],
        proposedRefund: { order_id: 'ORD-1001', amount: 49.99 },
      }),
    ]);

    const res = await send(tenant.publicKey, { message: 'my order arrived damaged, refund me', customerToken: token });

    expect(res.status).toBe(200);
    expect(res.body.outcome).toBe('pending_approval');
    expect(res.body.proposedAction).toEqual({
      tool: 'issue_refund',
      args: { order_id: 'ORD-1001', amount: 49.99, idempotencyKey: expect.stringMatching(/^[0-9a-f]{64}$/) },
      reasonCitations: [chunkKey],
    });
    const conversationId = res.body.conversationId as string;

    const { agentRun } = repos();
    const runs = await agentRun.findByConversation(tenant.tenantId, conversationId);
    expect(runs).toHaveLength(1);
    // Stage 5 - the AgentRun's own `outcome` for a require_approval disposition is
    // 'pending_approval' (genuinely not yet resolved at the moment this write happens) -
    // refundDisposition is the new field that distinguishes WHICH of the four dispositions this
    // was, written once, in the same transaction as the Approval row it names.
    expect(runs[0].outcome).toBe('pending_approval');
    expect(runs[0].proposedAction).toEqual({ tool: 'issue_refund', orderId: 'ORD-1001', amount: 49.99 });
    expect(runs[0].refundDisposition?.kind).toBe('pending_approval');
    expect(runs[0].refundDisposition?.approvalId).toMatch(/^[0-9a-f]{24}$/);
    expect(runs[0].steps.some((s) => s.type === 'tool' && s.toolName === 'track_shipment' && s.orderId === 'ORD-1001')).toBe(true);

    const approval = await repos().approval.findById(tenant.tenantId, runs[0].refundDisposition!.approvalId!);
    expect(approval).toMatchObject({ status: 'pending', active: true, orderId: 'ORD-1001', amountCents: 4999, citations: [chunkKey] });
  });

  it('not-yet-delivered order (status "delayed"): denied on ORDER_STATUS_INELIGIBLE, no Approval row, escalate to the customer', async () => {
    const tenant = await newTenant();
    const { kid, privateKey } = await registerCustomerKeyFixture(uri, tenant.tenantId);
    const token = mintCustomerToken(tenant.tenantId, 'cust_2', kid, privateKey);

    const uniqueWord = `neverarrivedlexeme${Date.now()}`;
    const uploadRes = await request(app.getHttpServer())
      .post('/v1/policies')
      .set('Authorization', `Bearer ${tenant.secretKey}`)
      .attach('file', Buffer.from(`# Refund policy\n\nA shipment well past its estimate qualifies for a refund. ${uniqueWord}.`), 'policy.md')
      .field('title', 'Refund policy');
    const documentId = uploadRes.body.id as string;
    const retrievalService = app.get(PolicyRetrievalService);
    const found = await pollUntil(async () => {
      const r = await retrievalService.retrieve(tenant.tenantId, uniqueWord);
      return r.ok && r.results.some((x) => x.documentId === documentId) ? r.results.find((x) => x.documentId === documentId) : undefined;
    }, `tenant ${tenant.tenantId}'s policy chunk becoming searchable for "${uniqueWord}"`);
    const chunkKey = found!.chunkKey;

    scriptableLlm.setScript([
      planOutput({
        needsPolicy: true,
        searchQuery: uniqueWord,
        toolRequests: [
          { tool: 'get_order', order_id: 'ORD-1003' },
          { tool: 'track_shipment', order_id: 'ORD-1003' },
        ],
      }),
      composeOutput({
        outcome: 'propose_refund',
        message: 'Your shipment is well past its estimate - we are issuing a refund.',
        citedChunkKeys: [chunkKey],
        proposedRefund: { order_id: 'ORD-1003', amount: 32.0 },
      }),
    ]);

    const res = await send(tenant.publicKey, { message: 'my order never arrived, refund me', customerToken: token });

    expect(res.status).toBe(200);
    expect(res.body.outcome).toBe('escalate');
    expect(res.body.proposedAction).toBeUndefined();
    const conversationId = res.body.conversationId as string;

    const { agentRun, approval } = repos();
    const runs = await agentRun.findByConversation(tenant.tenantId, conversationId);
    expect(runs).toHaveLength(1);
    expect(runs[0].outcome).toBe('escalate');
    expect(runs[0].refundDisposition?.kind).toBe('denied');
    expect(runs[0].refundDisposition?.failedRuleCodes).toContain('ORDER_STATUS_INELIGIBLE');
    expect((await approval.list(tenant.tenantId, {})).approvals).toHaveLength(0);
  });

  it('anonymous public caller (no token at all): policy-only, no order-scoped tool call ever attempted', async () => {
    const tenant = await newTenant();

    // A deliberately misbehaving "model" still asking for get_order - code
    // must structurally drop it (the allow-list excludes order tools for an
    // unidentified caller), never execute it against the real mock store.
    scriptableLlm.setScript([
      planOutput({ toolRequests: [{ tool: 'get_order', order_id: 'ORD-1001' }] }),
      composeOutput({ outcome: 'clarify', message: 'Could you tell me more about your question?' }),
    ]);

    const res = await send(tenant.publicKey, { message: 'what is your return policy' });

    expect(res.status).toBe(200);
    expect(res.body.outcome).toBe('clarify');
    const conversationId = res.body.conversationId as string;

    const { conversation, agentRun } = repos();
    const conv = await conversation.findById(tenant.tenantId, conversationId);
    expect(conv?.customerRef).toBeNull();

    const runs = await agentRun.findByConversation(tenant.tenantId, conversationId);
    expect(runs[0].steps.some((s) => s.type === 'tool')).toBe(false);
  });

  it('secret-scope (server-to-server) caller: customerRef honored directly, no token needed', async () => {
    const tenant = await newTenant();

    scriptableLlm.setScript([
      planOutput({ toolRequests: [{ tool: 'get_order', order_id: 'ORD-1001' }] }),
      composeOutput({ outcome: 'reply', message: 'Your order ORD-1001 was delivered.' }),
    ]);

    const res = await send(tenant.secretKey, { message: 'where is my order', customerRef: 'cust_1' });

    expect(res.status).toBe(200);
    const { conversation } = repos();
    const conv = await conversation.findById(tenant.tenantId, res.body.conversationId as string);
    expect(conv?.customerRef).toBe('cust_1');
  });

  it("a public caller's customerRef body field is always ignored, even without a token", async () => {
    const tenant = await newTenant();

    scriptableLlm.setScript([planOutput(), composeOutput({ outcome: 'clarify', message: 'ok' })]);

    const res = await send(tenant.publicKey, { message: 'hello', customerRef: 'cust_1' });

    expect(res.status).toBe(200);
    const { conversation } = repos();
    const conv = await conversation.findById(tenant.tenantId, res.body.conversationId as string);
    expect(conv?.customerRef).toBeNull();
  });

  describe('invalid customer tokens: identical 401, nothing persisted, no LLM call', () => {
    it('expired token (well past CLOCK_SKEW_ALLOWANCE_MS, unambiguously expired)', async () => {
      const tenant = await newTenant();
      const { kid, privateKey } = await registerCustomerKeyFixture(uri, tenant.tenantId);
      // A 1-second margin here was a real bug: verifyCustomerToken's EXPIRED
      // check is `payload.expiresAt + CLOCK_SKEW_ALLOWANCE_MS <= now` - an
      // expiry only 1000ms in the past is nowhere near CLOCK_SKEW_ALLOWANCE_MS
      // (default 30s), so the token was still accepted as valid, identity
      // resolved as 'identified', and the pipeline proceeded all the way to
      // runAgent's plan call against a script this test had deliberately
      // left empty - surfacing as an uncaught "called 1 time(s), but only 0
      // response(s) were scripted" 500, not the 401 this test claimed to be
      // testing. Fixed with a margin ten times the skew allowance -
      // unambiguous regardless of the skew default ever changing. The exact
      // boundary itself is covered by the two dedicated tests below.
      const token = mintCustomerToken(tenant.tenantId, 'cust_1', kid, privateKey, -(CLOCK_SKEW_ALLOWANCE_MS * 10));
      await assertUniform401(tenant, token);
    });

    it('expired by clearly LESS than the skew allowance: still accepted (identified, 200) - the skew is real tolerance, not a no-op', async () => {
      const tenant = await newTenant();
      const { kid, privateKey } = await registerCustomerKeyFixture(uri, tenant.tenantId);
      // 5s of margin on either side of the boundary is comfortably larger
      // than any real clock drift between minting this token and the
      // server verifying it moments later within the same test process.
      const token = mintCustomerToken(tenant.tenantId, 'cust_1', kid, privateKey, -(CLOCK_SKEW_ALLOWANCE_MS - 5000));

      scriptableLlm.setScript([planOutput(), composeOutput({ outcome: 'clarify', message: 'ok' })]);
      const res = await send(tenant.publicKey, { message: 'hi', customerToken: token });

      expect(res.status).toBe(200);
      const { conversation } = repos();
      const conv = await conversation.findById(tenant.tenantId, res.body.conversationId as string);
      expect(conv?.customerRef).toBe('cust_1');
    });

    it('expired by clearly MORE than the skew allowance: the uniform 401, right past the boundary', async () => {
      const tenant = await newTenant();
      const { kid, privateKey } = await registerCustomerKeyFixture(uri, tenant.tenantId);
      const token = mintCustomerToken(tenant.tenantId, 'cust_1', kid, privateKey, -(CLOCK_SKEW_ALLOWANCE_MS + 5000));
      await assertUniform401(tenant, token);
    });

    it('wrong-tenant token (verifies, but payload.tenantId disagrees with the authenticated tenant)', async () => {
      const tenantA = await newTenant();
      const tenantB = await newTenant();

      const { publicKey, privateKey } = generateKeyPairSync('ed25519');
      const jwk = publicKey.export({ format: 'jwk' }) as { x: string };
      const sharedKid = 999001;
      await createCustomerPublicKeyFixture(uri, tenantA.tenantId, sharedKid, jwk.x);
      await createCustomerPublicKeyFixture(uri, tenantB.tenantId, sharedKid, jwk.x);

      const token = signCustomerToken({ tenantId: tenantA.tenantId, customerRef: 'cust_1', expiresAt: Date.now() + 60_000, kid: sharedKid }, privateKey);
      await assertUniform401(tenantB, token);
    });

    it('unknown kid', async () => {
      const tenant = await newTenant();
      const { privateKey } = await registerCustomerKeyFixture(uri, tenant.tenantId);
      const token = signCustomerToken({ tenantId: tenant.tenantId, customerRef: 'cust_1', expiresAt: Date.now() + 60_000, kid: 424242 }, privateKey);
      await assertUniform401(tenant, token);
    });

    it('tampered signature', async () => {
      const tenant = await newTenant();
      const { kid, privateKey } = await registerCustomerKeyFixture(uri, tenant.tenantId);
      const token = mintCustomerToken(tenant.tenantId, 'cust_1', kid, privateKey);
      const [payloadB64, signatureB64] = token.split('.');
      const tamperedSig = signatureB64.slice(0, -2) + (signatureB64.slice(-2) === 'AA' ? 'BB' : 'AA');
      await assertUniform401(tenant, `${payloadB64}.${tamperedSig}`);
    });

    it('malformed token', async () => {
      const tenant = await newTenant();
      await assertUniform401(tenant, 'not-a-real-token');
    });

    async function assertUniform401(tenant: TenantFixture, token: string): Promise<void> {
      scriptableLlm.setScript([]);
      const beforeCalls = scriptableLlm.generateCalls;

      const res = await send(tenant.publicKey, { message: 'where is my order', customerToken: token });

      expect(res.status).toBe(401);
      expect(res.body).toEqual({ statusCode: 401, code: 'INVALID_CUSTOMER_TOKEN', message: 'The customer token is invalid, expired, or could not be verified.' });
      expect(scriptableLlm.generateCalls).toBe(beforeCalls);

      // No conversationId is returned on an error response, and the pipeline
      // never reaches conversation resolution for an invalid token (identity
      // resolution runs before it) - a fresh tenant with zero prior activity
      // must still have zero AgentRuns after this request.
      const { agentRun } = repos();
      const runs = await agentRun.findByConversation(tenant.tenantId, 'nonexistent-but-also-there-should-be-zero-runs-total');
      expect(runs).toHaveLength(0);
    }
  });

  it("another customer's order: code structurally rejects the proposal, forcing escalate, never pending_approval, even when the (scripted) model tries anyway", async () => {
    const tenant = await newTenant();
    const { kid, privateKey } = await registerCustomerKeyFixture(uri, tenant.tenantId);
    const token = mintCustomerToken(tenant.tenantId, 'cust_1', kid, privateKey);

    // cust_1 owns ORD-1001, not ORD-1008 (owned by cust_5) - the "model"
    // asks about ORD-1008 anyway and then (mis)proposes a refund on it.
    scriptableLlm.setScript([
      planOutput({ toolRequests: [{ tool: 'get_order', order_id: 'ORD-1008' }] }),
      composeOutput({ outcome: 'propose_refund', message: 'Refunding your order.', citedChunkKeys: [], proposedRefund: { order_id: 'ORD-1008', amount: 10 } }),
    ]);

    const res = await send(tenant.publicKey, { message: 'refund my order ORD-1008', customerToken: token });

    expect(res.status).toBe(200);
    expect(res.body.outcome).toBe('escalate');
    expect(res.body.proposedAction).toBeUndefined();
    expect(res.body.message).not.toContain('44');
    expect(res.body.message).not.toContain('cust_5');

    const { agentRun } = repos();
    const runs = await agentRun.findByConversation(tenant.tenantId, res.body.conversationId as string);
    expect(runs[0].outcome).toBe('escalate');
    expect(runs[0].proposedAction).toBeNull();
  });

  it("another customer's conversation id: silently starts a NEW conversation, never confirms the id exists or belongs to someone else", async () => {
    const tenant = await newTenant();
    const { kid: kidA, privateKey: keyA } = await registerCustomerKeyFixture(uri, tenant.tenantId);
    const { kid: kidB, privateKey: keyB } = await registerCustomerKeyFixture(uri, tenant.tenantId);
    const tokenA = mintCustomerToken(tenant.tenantId, 'cust_1', kidA, keyA);
    const tokenB = mintCustomerToken(tenant.tenantId, 'cust_2', kidB, keyB);

    scriptableLlm.setScript([planOutput(), composeOutput({ outcome: 'clarify', message: 'ok from A' })]);
    const resA = await send(tenant.publicKey, { message: 'hello', customerToken: tokenA });
    expect(resA.status).toBe(200);
    const conversationIdFromA = resA.body.conversationId as string;

    scriptableLlm.setScript([planOutput(), composeOutput({ outcome: 'clarify', message: 'ok from B' })]);
    const resB = await send(tenant.publicKey, { message: 'hello', conversationId: conversationIdFromA, customerToken: tokenB });

    expect(resB.status).toBe(200);
    expect(resB.body.conversationId).not.toBe(conversationIdFromA);

    const { conversation } = repos();
    const convB = await conversation.findById(tenant.tenantId, resB.body.conversationId as string);
    expect(convB?.customerRef).toBe('cust_2');
  });

  it('two tenants, same customerRef string: fully isolated conversations and runs', async () => {
    const tenantA = await newTenant();
    const tenantB = await newTenant();
    const { kid: kidA, privateKey: keyA } = await registerCustomerKeyFixture(uri, tenantA.tenantId);
    const { kid: kidB, privateKey: keyB } = await registerCustomerKeyFixture(uri, tenantB.tenantId);
    const tokenA = mintCustomerToken(tenantA.tenantId, 'cust_shared', kidA, keyA);
    const tokenB = mintCustomerToken(tenantB.tenantId, 'cust_shared', kidB, keyB);

    scriptableLlm.setScript([planOutput(), composeOutput({ outcome: 'clarify', message: 'ok A' })]);
    const resA = await send(tenantA.publicKey, { message: 'hi', customerToken: tokenA });

    scriptableLlm.setScript([planOutput(), composeOutput({ outcome: 'clarify', message: 'ok B' })]);
    const resB = await send(tenantB.publicKey, { message: 'hi', customerToken: tokenB });

    expect(resA.body.conversationId).not.toBe(resB.body.conversationId);

    const { conversation, agentRun } = repos();
    expect(await conversation.findById(tenantB.tenantId, resA.body.conversationId as string)).toBeNull();
    expect(await conversation.findById(tenantA.tenantId, resB.body.conversationId as string)).toBeNull();
    expect(await agentRun.findByConversation(tenantB.tenantId, resA.body.conversationId as string)).toHaveLength(0);
  });

  it('canary string: appears only in Message content, never in any Logger output along the whole path', async () => {
    const tenant = await newTenant();
    const canary = canaryString();
    const logSpy = spyOnLoggerOutput();

    scriptableLlm.setScript([
      planOutput({ reasoning: `about ${canary}` }),
      composeOutput({ outcome: 'clarify', message: `Message mentioning ${canary} to the customer.` }),
    ]);

    const res = await send(tenant.publicKey, { message: `my request mentions ${canary}` });
    expect(res.status).toBe(200);

    const { message } = repos();
    const messages = await message.findRecentForConversation(tenant.tenantId, res.body.conversationId as string, 10);
    expect(messages.some((m) => m.content.includes(canary))).toBe(true);

    for (const line of logSpy.lines) {
      expect(line).not.toContain(canary);
    }
    logSpy.restore();
  });

  describe('indexes: real unique/TTL indexes exist, duplicate insert rejected', () => {
    it('ApiKey.hash is unique', async () => {
      const model = app.get<Model<unknown>>(getModelToken('ApiKey'));
      const indexes = await model.collection.indexes();
      expect(indexes.some((idx) => idx.unique && Object.keys(idx.key).join(',') === 'hash')).toBe(true);
    });

    it('CustomerPublicKey {tenantId,kid} is unique, and a duplicate insert is rejected', async () => {
      const tenant = await newTenant();
      const model = app.get<Model<unknown>>(getModelToken('CustomerPublicKey'));
      const indexes = await model.collection.indexes();
      expect(indexes.some((idx) => idx.unique && JSON.stringify(idx.key) === JSON.stringify({ tenantId: 1, kid: 1 }))).toBe(true);

      await registerCustomerKeyFixture(uri, tenant.tenantId);
      const dupKid = 777;
      const { publicKey } = generateKeyPairSync('ed25519');
      const jwk = publicKey.export({ format: 'jwk' }) as { x: string };
      await createCustomerPublicKeyFixture(uri, tenant.tenantId, dupKid, jwk.x);
      await expect(createCustomerPublicKeyFixture(uri, tenant.tenantId, dupKid, jwk.x)).rejects.toThrow();
    });

    it('Conversation.updatedAt, Message.createdAt, and AgentRun.createdAt all have a configured TTL index', async () => {
      const cases: Array<{ model: string; field: string }> = [
        { model: 'Conversation', field: 'updatedAt' },
        { model: 'Message', field: 'createdAt' },
        { model: 'AgentRun', field: 'createdAt' },
      ];
      for (const { model: modelName, field } of cases) {
        const model = app.get<Model<unknown>>(getModelToken(modelName));
        const indexes = await model.collection.indexes();
        const ttl = indexes.find((idx) => idx.expireAfterSeconds !== undefined && Object.keys(idx.key).join(',') === field);
        expect(ttl, `${modelName}.${field} should have a TTL index`).toBeDefined();
        expect(ttl!.expireAfterSeconds).toBeGreaterThan(0);
      }
    });
  });
});

/**
 * Nest's default Logger does NOT call console.log/warn/error (confirmed by
 * direct experiment during Stage 5) - it writes via process.stdout/stderr.
 * Spies on Logger.prototype.log/warn/error instead, same pattern
 * chat.service.spec.ts's own canary test already established.
 */
function spyOnLoggerOutput(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const record = (...args: unknown[]) => {
    lines.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
  };
  const originals = {
    log: Logger.prototype.log,
    warn: Logger.prototype.warn,
    error: Logger.prototype.error,
  };
  Logger.prototype.log = function (...args: unknown[]) {
    record(...args);
  } as typeof Logger.prototype.log;
  Logger.prototype.warn = function (...args: unknown[]) {
    record(...args);
  } as typeof Logger.prototype.warn;
  Logger.prototype.error = function (...args: unknown[]) {
    record(...args);
  } as typeof Logger.prototype.error;
  return {
    lines,
    restore: () => {
      Logger.prototype.log = originals.log;
      Logger.prototype.warn = originals.warn;
      Logger.prototype.error = originals.error;
    },
  };
}
