/**
 * Milestone 4 Stage 6 - the real admin HTTP surface (GET /v1/approvals,
 * GET /v1/approvals/:id, POST /v1/approvals/:id/decision), against the real
 * AppModule, the real database, and the real in-process mock store. Every
 * scenario here drives the routes exactly as an admin console would - no
 * app.get(ApprovalService) shortcuts (those exist elsewhere, pre-Stage-6, as
 * stand-ins that are being retired now that the real route exists).
 *
 * Order-id bookkeeping (read before adding a new test): the mock store is
 * ONE shared in-process instance for this whole file, and RefundStore
 * allows at most ONE real refund ever per order id, globally, regardless of
 * tenant. Only THREE seeded orders are "clean" (delivered, in-window, never
 * already refunded) - ORD-1001, ORD-1006, ORD-1008 - so each is reserved for
 * exactly one test that actually consumes it (a real executed refund, or a
 * direct out-of-band refund call standing in for "refunded through another
 * channel"). Every OTHER test in this file reuses ORD-1001 non-consumingly
 * (reject/expire/deny-at-decision never call the real refund endpoint) and
 * is declared BEFORE the test that finally consumes ORD-1001, since Vitest
 * runs `it()` blocks in declaration order within a describe block.
 */
import './test-env';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { Logger } from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { getModelToken } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import { ComposeOutput, PlannerOutput } from '@supportpilot/shared';
import { AppModule } from '../../src/app.module';
import { LLM_PROVIDER } from '../../src/llm/llm.module';
import { GenerateOutcome } from '../../src/llm/llm-provider.interface';
import { PolicyRetrievalService } from '../../src/retrieval/policy-retrieval.service';
import { RateLimiter } from '../../src/auth/rate-limiter';
import { CUSTOMER_REF_RATE_LIMITER } from '../../src/chat/rate-limiters.provider';
import { AGENT_RUN_REPOSITORY, AgentRunRepository } from '../../src/db/agent-run.repository';
import { APPROVAL_REPOSITORY, ApprovalRepository } from '../../src/approvals/approval.repository';
import { ApprovalDocument } from '../../src/approvals/schemas/approval.schema';
import {
  cleanupTenant,
  createApiKeyFixture,
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

/** Same spy pattern approvals-chat.integration-spec.ts's own canary test uses. */
function spyOnLoggerOutput(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const record = (...args: unknown[]) => {
    lines.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
  };
  const originals = { log: Logger.prototype.log, warn: Logger.prototype.warn, error: Logger.prototype.error };
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

describe.skipIf(!integrationTestsEnabled())('Admin approvals API (integration, real database)', () => {
  let app: INestApplication;
  let mockStore: MockStoreHandle;
  let tempConnectorRoot: string;
  let scriptableLlm: ScriptableLlmProvider;
  const uri = integrationTestsEnabled() ? getTestMongoUri() : '';
  const createdTenants: string[] = [];

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
      // This file's seeded orders fix their owner's customerRef (ORD-1001 -> cust_1), and
      // CUSTOMER_REF_RATE_LIMITER buckets by that raw string GLOBALLY, not scoped per tenant
      // (chat.service.ts's own design, PROJECT.md amendment B) - reusing cust_1 across this
      // file's many non-consuming scenarios would otherwise exhaust the real 10-per-60s default
      // well before the file finishes, same reasoning chat.controller.spec.ts's own override
      // already documents for its unit tests.
      .overrideProvider(CUSTOMER_REF_RATE_LIMITER)
      .useValue(new RateLimiter({ maxRequests: 1000, windowMs: 60_000, maxEntries: 1000 }, () => new Date()))
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

  function repos(): { agentRun: AgentRunRepository; approval: ApprovalRepository } {
    return { agentRun: app.get(AGENT_RUN_REPOSITORY), approval: app.get(APPROVAL_REPOSITORY) };
  }

  async function seedCitableChunk(tenant: TenantFixture, text: string): Promise<{ chunkKey: string; uniqueWord: string }> {
    const uniqueWord = `admapi${Date.now()}${Math.random().toString(36).slice(2)}`;
    const uploadRes = await request(app.getHttpServer())
      .post('/v1/policies')
      .set('Authorization', `Bearer ${tenant.secretKey}`)
      .attach('file', Buffer.from(`# Policy\n\n${text} ${uniqueWord}.`), 'policy.md')
      .field('title', 'Policy');
    const documentId = uploadRes.body.id as string;
    const retrievalService = app.get(PolicyRetrievalService);
    const found = await pollUntil(async () => {
      const r = await retrievalService.retrieve(tenant.tenantId, uniqueWord);
      return r.ok && r.results.some((x) => x.documentId === documentId) ? r.results.find((x) => x.documentId === documentId) : undefined;
    }, `tenant ${tenant.tenantId}'s policy chunk becoming searchable for "${uniqueWord}"`);
    return { chunkKey: found!.chunkKey, uniqueWord };
  }

  /** Proposes a refund for `orderId` and returns the resulting approvalId, via the real /v1/chat path - never a direct repository insert. */
  async function proposeRefund(tenant: TenantFixture, orderId: string, amount: number, customerRef = 'cust_1'): Promise<{ approvalId: string; conversationId: string }> {
    const { kid, privateKey } = await registerCustomerKeyFixture(uri, tenant.tenantId);
    const token = mintCustomerToken(tenant.tenantId, customerRef, kid, privateKey);
    const { chunkKey, uniqueWord } = await seedCitableChunk(tenant, 'A delivered order that arrived damaged can be refunded.');

    scriptableLlm.setScript([
      planOutput({ needsPolicy: true, searchQuery: uniqueWord, toolRequests: [{ tool: 'get_order', order_id: orderId }] }),
      composeOutput({ outcome: 'propose_refund', message: 'Refunding you.', citedChunkKeys: [chunkKey], proposedRefund: { order_id: orderId, amount } }),
    ]);

    const res = await request(app.getHttpServer())
      .post('/v1/chat')
      .set('Authorization', `Bearer ${tenant.publicKey}`)
      .send({ message: 'refund my damaged order', customerToken: token });
    expect(res.body.outcome).toBe('pending_approval');

    const runs = await repos().agentRun.findByConversation(tenant.tenantId, res.body.conversationId as string);
    return { approvalId: runs[0].refundDisposition!.approvalId!, conversationId: res.body.conversationId as string };
  }

  function decide(adminKey: string, approvalId: string, body: Record<string, unknown>) {
    return request(app.getHttpServer()).post(`/v1/approvals/${approvalId}/decision`).set('Authorization', `Bearer ${adminKey}`).send(body);
  }

  describe('list, get, and the scope matrix', () => {
    it('GET /v1/approvals and GET /v1/approvals/:id return an ApprovalRecordSchema view, never the idempotency key or internal fields', async () => {
      const tenant = await newTenant();
      const adminKey = (await createApiKeyFixture(uri, tenant.tenantId, 'admin')).rawKey;
      const { approvalId } = await proposeRefund(tenant, 'ORD-1001', 10);

      const listRes = await request(app.getHttpServer()).get('/v1/approvals').set('Authorization', `Bearer ${adminKey}`);
      expect(listRes.status).toBe(200);
      expect(listRes.body.approvals).toHaveLength(1);
      expect(listRes.body.approvals[0].id).toBe(approvalId);
      expect(listRes.body.approvals[0]).not.toHaveProperty('idempotencyKey');
      expect(listRes.body.approvals[0]).not.toHaveProperty('verifierVerdictAtProposal');

      const getRes = await request(app.getHttpServer()).get(`/v1/approvals/${approvalId}`).set('Authorization', `Bearer ${adminKey}`);
      expect(getRes.status).toBe(200);
      expect(getRes.body).toMatchObject({ id: approvalId, orderId: 'ORD-1001', amount: 10, status: 'pending' });
      expect(getRes.body).not.toHaveProperty('idempotencyKey');
    });

    it('404 with an identical body for another tenant\'s id and for a nonexistent id', async () => {
      const tenantA = await newTenant();
      const tenantB = await newTenant();
      const adminKeyB = (await createApiKeyFixture(uri, tenantB.tenantId, 'admin')).rawKey;
      const { approvalId } = await proposeRefund(tenantA, 'ORD-1001', 10);

      const crossTenant = await request(app.getHttpServer()).get(`/v1/approvals/${approvalId}`).set('Authorization', `Bearer ${adminKeyB}`);
      const nonexistent = await request(app.getHttpServer()).get('/v1/approvals/000000000000000000000000').set('Authorization', `Bearer ${adminKeyB}`);

      expect(crossTenant.status).toBe(404);
      expect(nonexistent.status).toBe(404);
      expect(crossTenant.body).toEqual(nonexistent.body);
    });

    it('secret and public keys get the generic auth rejection on all three routes; an admin key succeeds; no key is rejected too', async () => {
      const tenant = await newTenant();
      const adminKey = (await createApiKeyFixture(uri, tenant.tenantId, 'admin')).rawKey;
      const { approvalId } = await proposeRefund(tenant, 'ORD-1001', 10);

      // A missing key and a present-but-insufficient-scope key both produce the SAME generic 401
      // (api-key.guard.ts's own documented design - never a 403, so a probing caller can never
      // distinguish "wrong scope" from "no key at all").
      for (const key of [tenant.secretKey, tenant.publicKey]) {
        const listRes = await request(app.getHttpServer()).get('/v1/approvals').set('Authorization', `Bearer ${key}`);
        const getRes = await request(app.getHttpServer()).get(`/v1/approvals/${approvalId}`).set('Authorization', `Bearer ${key}`);
        const decisionRes = await decide(key, approvalId, { decision: 'approve' });
        expect(listRes.status).toBe(401);
        expect(getRes.status).toBe(401);
        expect(decisionRes.status).toBe(401);
      }

      const noKeyRes = await request(app.getHttpServer()).get('/v1/approvals');
      expect(noKeyRes.status).toBe(401);

      const adminListRes = await request(app.getHttpServer()).get('/v1/approvals').set('Authorization', `Bearer ${adminKey}`);
      expect(adminListRes.status).toBe(200);
    });
  });

  it('reject sends no upstream call: the mock store is untouched, and the rejected approval records the admin reason code', async () => {
    const tenant = await newTenant();
    const adminKey = (await createApiKeyFixture(uri, tenant.tenantId, 'admin')).rawKey;
    const { approvalId } = await proposeRefund(tenant, 'ORD-1001', 10, 'cust_1');

    const res = await decide(adminKey, approvalId, { decision: 'reject', reasonCode: 'POLICY_VIOLATION' });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'rejected', adminReasonCode: 'POLICY_VIOLATION' });

    const orderRes = await fetch(`${mockStore.baseUrl}/orders/ORD-1001`, { headers: { Authorization: `Bearer ${MOCK_STORE_TOKEN}` } });
    const orderBody = (await orderRes.json()) as { status: string; alreadyRefundedTotal: number };
    expect(orderBody.status).toBe('delivered'); // never touched - no refund was ever sent
    expect(orderBody.alreadyRefundedTotal).toBe(0);
  });

  it('reject is itself a validated enum, never free text: an unrecognized reasonCode is rejected at the HTTP boundary', async () => {
    const tenant = await newTenant();
    const adminKey = (await createApiKeyFixture(uri, tenant.tenantId, 'admin')).rawKey;
    const { approvalId } = await proposeRefund(tenant, 'ORD-1001', 10);

    const res = await decide(adminKey, approvalId, { decision: 'reject', reasonCode: 'the customer called and asked nicely' });
    expect(res.status).toBe(400);

    // Still pending afterward - the bad request never touched the approval's state.
    const getRes = await request(app.getHttpServer()).get(`/v1/approvals/${approvalId}`).set('Authorization', `Bearer ${adminKey}`);
    expect(getRes.body.status).toBe('pending');
  });

  it('decisions after expiry write expired and return 409 EXPIRED', async () => {
    const tenant = await newTenant();
    const adminKey = (await createApiKeyFixture(uri, tenant.tenantId, 'admin')).rawKey;
    const { approvalId } = await proposeRefund(tenant, 'ORD-1001', 10);

    // Backdate expiresAt directly (no sleeping, no repository.expire() call - that would flip
    // status itself; this test needs the row to STILL be 'pending' so the admin's own decide()
    // call is what performs the real pending -> expired transition, per approveFromPending's own
    // expiry check).
    const approvalModel = app.get<Model<ApprovalDocument>>(getModelToken('Approval'));
    await approvalModel.updateOne({ _id: approvalId }, { $set: { expiresAt: new Date(Date.now() - 1000) } });

    const res = await decide(adminKey, approvalId, { decision: 'approve' });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('EXPIRED');

    const getRes = await request(app.getHttpServer()).get(`/v1/approvals/${approvalId}`).set('Authorization', `Bearer ${adminKey}`);
    expect(getRes.body.status).toBe('expired');
  });

  it('every lost race returns 409 ALREADY_DECIDED: a second decision after a first terminal one is rejected', async () => {
    const tenant = await newTenant();
    const adminKey = (await createApiKeyFixture(uri, tenant.tenantId, 'admin')).rawKey;
    const { approvalId } = await proposeRefund(tenant, 'ORD-1001', 10);

    const first = await decide(adminKey, approvalId, { decision: 'reject', reasonCode: 'CUSTOMER_WITHDREW_REQUEST' });
    expect(first.status).toBe(200);

    const second = await decide(adminKey, approvalId, { decision: 'reject', reasonCode: 'CUSTOMER_WITHDREW_REQUEST' });
    expect(second.status).toBe(409);
    expect(second.body.code).toBe('ALREADY_DECIDED');
  });

  it('tenant isolation: two tenants proposing against the same order id each only ever see their own Approval row through the admin routes', async () => {
    const tenantA = await newTenant();
    const tenantB = await newTenant();
    const adminKeyA = (await createApiKeyFixture(uri, tenantA.tenantId, 'admin')).rawKey;
    const adminKeyB = (await createApiKeyFixture(uri, tenantB.tenantId, 'admin')).rawKey;

    const { approvalId: idA } = await proposeRefund(tenantA, 'ORD-1001', 10);
    const { approvalId: idB } = await proposeRefund(tenantB, 'ORD-1001', 10);
    expect(idA).not.toBe(idB);

    const listA = await request(app.getHttpServer()).get('/v1/approvals').set('Authorization', `Bearer ${adminKeyA}`);
    const listB = await request(app.getHttpServer()).get('/v1/approvals').set('Authorization', `Bearer ${adminKeyB}`);
    expect(listA.body.approvals.map((a: { id: string }) => a.id)).toEqual([idA]);
    expect(listB.body.approvals.map((a: { id: string }) => a.id)).toEqual([idB]);

    const crossGet = await request(app.getHttpServer()).get(`/v1/approvals/${idA}`).set('Authorization', `Bearer ${adminKeyB}`);
    expect(crossGet.status).toBe(404);

    // Resolve both harmlessly (reject) so neither leaves an active row claiming ORD-1001 for
    // the rest of this file - cheap defensive cleanup, not required by the assertions above.
    await decide(adminKeyA, idA, { decision: 'reject', reasonCode: 'OTHER' });
    await decide(adminKeyB, idB, { decision: 'reject', reasonCode: 'OTHER' });
  });

  it('canary string through the decision path: never appears in any Logger output, including the audit log line', async () => {
    const tenant = await newTenant();
    const adminKey = (await createApiKeyFixture(uri, tenant.tenantId, 'admin')).rawKey;
    const canary = canaryString();
    const { kid, privateKey } = await registerCustomerKeyFixture(uri, tenant.tenantId);
    const token = mintCustomerToken(tenant.tenantId, 'cust_1', kid, privateKey);
    const { chunkKey, uniqueWord } = await seedCitableChunk(tenant, 'A delivered order that arrived damaged can be refunded.');

    scriptableLlm.setScript([
      // needsPolicy/searchQuery must be set, same as every other test's planOutput() - without a
      // real retrieve step, citedChunkKeys below is re-checked against an EMPTY actually-retrieved
      // set and dropped (never trusted at face value), failing the verifier's citation rule and
      // producing a 'denied' disposition with no approvalId at all - a silent cause of the 404
      // this test originally failed with, not a product bug.
      planOutput({ reasoning: `about ${canary}`, needsPolicy: true, searchQuery: uniqueWord, toolRequests: [{ tool: 'get_order', order_id: 'ORD-1001' }] }),
      composeOutput({ outcome: 'propose_refund', message: `Refunding you, re: ${canary}.`, citedChunkKeys: [chunkKey], proposedRefund: { order_id: 'ORD-1001', amount: 10 } }),
    ]);
    const chatRes = await request(app.getHttpServer()).post('/v1/chat').set('Authorization', `Bearer ${tenant.publicKey}`).send({ message: `refund me, ${canary}`, customerToken: token });
    expect(chatRes.body.outcome).toBe('pending_approval');
    const runs = await repos().agentRun.findByConversation(tenant.tenantId, chatRes.body.conversationId as string);
    const approvalId = runs[0].refundDisposition!.approvalId!;

    const logSpy = spyOnLoggerOutput();
    const res = await decide(adminKey, approvalId, { decision: 'reject', reasonCode: 'OTHER' });
    expect(res.status).toBe(200);
    for (const line of logSpy.lines) {
      expect(line).not.toContain(canary);
    }
    logSpy.restore();
  });

  it('customer follow-up: after reject, ONE code-built agent message is appended and visible on the next chat turn; messageCount/updatedAt are bumped', async () => {
    const tenant = await newTenant();
    const adminKey = (await createApiKeyFixture(uri, tenant.tenantId, 'admin')).rawKey;
    const { approvalId, conversationId } = await proposeRefund(tenant, 'ORD-1001', 10);

    const conversationModelBefore = app.get<Model<{ messageCount: number; updatedAt: Date }>>(getModelToken('Conversation'));
    const before = await conversationModelBefore.findOne({ _id: conversationId }).lean();

    const res = await decide(adminKey, approvalId, { decision: 'reject', reasonCode: 'OTHER' });
    expect(res.status).toBe(200);

    const after = await conversationModelBefore.findOne({ _id: conversationId }).lean();
    expect(after!.messageCount).toBe(before!.messageCount + 1);
    expect(after!.updatedAt.getTime()).toBeGreaterThan(before!.updatedAt.getTime());

    // Visible on the next chat turn - a plain follow-up message, same conversationId.
    scriptableLlm.setScript([planOutput({ toolRequests: [] }), composeOutput({ outcome: 'clarify', message: 'anything else?' })]);
    const nextTurn = await request(app.getHttpServer())
      .post('/v1/chat')
      .set('Authorization', `Bearer ${tenant.publicKey}`)
      .send({ message: 'ok thanks', conversationId });
    expect(nextTurn.status).toBe(200);

    const messageModel = app.get<Model<{ role: string; content: string }>>(getModelToken('Message'));
    const messages = await messageModel.find({ conversationId }).sort({ createdAt: 1 }).lean();
    const agentMessages = messages.filter((m) => m.role === 'agent');
    expect(agentMessages.some((m) => /not able to approve/i.test(m.content))).toBe(true);
  });

  it('order refunded elsewhere before approval (ORD-1008): the decision-time re-check fails the verifier with a recorded reasonCode, and no upstream issue_refund call is ever made', async () => {
    const tenant = await newTenant();
    const adminKey = (await createApiKeyFixture(uri, tenant.tenantId, 'admin')).rawKey;
    const { approvalId } = await proposeRefund(tenant, 'ORD-1008', 20, 'cust_5');

    // Simulate "refunded through another channel" - a DIRECT call to the mock store, bypassing
    // the connector/privileged-runner entirely, using a distinct idempotency key the Approval's
    // own flow could never produce.
    const outOfBandRes = await fetch(`${mockStore.baseUrl}/refunds`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${MOCK_STORE_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ orderId: 'ORD-1008', amount: 5, idempotencyKey: 'out-of-band-channel' }),
    });
    expect(outOfBandRes.status).toBe(201);

    const res = await decide(adminKey, approvalId, { decision: 'approve' });

    expect(res.status).toBe(200); // VERIFIER_DENIED is a successfully-processed decision, not an error
    expect(res.body.status).toBe('failed');
    expect(res.body.reasonCode).toBe('ORDER_STATUS_INELIGIBLE'); // the order's status is no longer 'delivered'

    const orderRes = await fetch(`${mockStore.baseUrl}/orders/ORD-1008`, { headers: { Authorization: `Bearer ${MOCK_STORE_TOKEN}` } });
    const orderBody = (await orderRes.json()) as { alreadyRefundedTotal: number };
    expect(orderBody.alreadyRefundedTotal).toBe(5); // only the out-of-band amount - the approval's own 20 was never sent
  });

  it('a concurrent double approve (ORD-1006, no sleeps): AT MOST one real refund, ever, regardless of how the race actually resolves', async () => {
    const tenant = await newTenant();
    const adminKey = (await createApiKeyFixture(uri, tenant.tenantId, 'admin')).rawKey;
    const { approvalId } = await proposeRefund(tenant, 'ORD-1006', 500, 'cust_3');

    // Promise.all fires both requests without any gap, but it does NOT prove they genuinely
    // overlapped inside the database - Node's event loop and the real network/driver timing
    // could just as easily let the first request run to full completion (including markExecuted)
    // before the second one's own findOneAndUpdate ever reaches Mongo. Both outcomes are
    // CORRECT and must both be accepted: a genuine overlap loses the race on beginExecution's own
    // atomic update and sees 409 IN_PROGRESS; a fully serialized second attempt instead finds the
    // row already 'executed' and sees 409 ALREADY_DECIDED. What this test actually proves - the
    // one invariant true under EITHER timing - is the mock store's own ledger: exactly one real
    // refund landed, never two, no matter which way the race fell.
    const [first, second] = await Promise.all([decide(adminKey, approvalId, { decision: 'approve' }), decide(adminKey, approvalId, { decision: 'approve' })]);

    const statuses = [first.status, second.status].sort();
    expect(statuses).toEqual([200, 409]);
    const loser = first.status === 409 ? first : second;
    expect(['IN_PROGRESS', 'ALREADY_DECIDED']).toContain(loser.body.code);

    const orderRes = await fetch(`${mockStore.baseUrl}/orders/ORD-1006`, { headers: { Authorization: `Bearer ${MOCK_STORE_TOKEN}` } });
    const orderBody = (await orderRes.json()) as { alreadyRefundedTotal: number };
    expect(orderBody.alreadyRefundedTotal).toBe(500); // exactly one execution, never doubled, regardless of how the race actually resolved
  });

  it('approve on pending (ORD-1001): runs the verifier once against fresh order data, executes the real refund exactly once, and the admin sees executed', async () => {
    const tenant = await newTenant();
    const adminKey = (await createApiKeyFixture(uri, tenant.tenantId, 'admin')).rawKey;
    const { approvalId } = await proposeRefund(tenant, 'ORD-1001', 10, 'cust_1');

    const res = await decide(adminKey, approvalId, { decision: 'approve' });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'executed', decidedBy: expect.any(String) });

    const orderRes = await fetch(`${mockStore.baseUrl}/orders/ORD-1001`, { headers: { Authorization: `Bearer ${MOCK_STORE_TOKEN}` } });
    const orderBody = (await orderRes.json()) as { alreadyRefundedTotal: number; status: string };
    expect(orderBody.alreadyRefundedTotal).toBe(10); // the real refund happened, exactly once
    expect(orderBody.status).toBe('refunded');
  });
});
