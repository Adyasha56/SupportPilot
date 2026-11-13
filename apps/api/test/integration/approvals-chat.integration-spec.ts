/**
 * Milestone 4, Stage 5 - the real-database integration suite for the NEW
 * seam `chat.service.ts` gained this stage: every refund proposal now
 * passes through `ApprovalProposalPort.createFromProposal` (the real
 * `ApprovalService`, the real refund-verifier, the real transactional
 * Approval+AgentRun dual-write, the real `PrivilegedRefundRunner` for
 * auto-execute) before the customer ever sees a result. Boots the REAL
 * AppModule the same way chat.integration-spec.ts does (see that file's
 * own header for the full rationale) - this file covers only the
 * scenarios THAT file doesn't: already-under-review, stale-expired
 * recovery, auto-execute on/off, tenant isolation for the Approval
 * collection itself, and a canary sweep through this specific path.
 * ("delivered-order refund within window" and "not-yet-delivered order:
 * denied" already live in chat.integration-spec.ts, next to the rest of
 * the happy-path/identity scenarios.)
 *
 * Deliberately NOT in this file, and not yet covered anywhere at the
 * integration level (documented here rather than silently skipped):
 *  - An ambiguous upstream failure during auto-execute (a mock store that
 *    times out mid-request) - chat-limits.integration-spec.ts's existing
 *    timeout-simulation pattern would need to be adapted for the
 *    privileged runner's own connector, not the LLM provider; deferred.
 *  - The dual-write transaction genuinely failing against a REAL Mongo
 *    session (proving "neither document exists" against the real
 *    cluster, not just the in-memory fakes) - approval.service.spec.ts's
 *    own unit tests already prove this against a fake TransactionRunner;
 *    the real-transaction version would need a second TestingModule with
 *    an overridden repository, which this suite's own performance
 *    rationale (one shared app boot) argues against building lightly.
 */
import './test-env';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { Logger } from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ComposeOutput, PlannerOutput } from '@supportpilot/shared';
import { AppModule } from '../../src/app.module';
import { LLM_PROVIDER } from '../../src/llm/llm.module';
import { GenerateOutcome } from '../../src/llm/llm-provider.interface';
import { PolicyRetrievalService } from '../../src/retrieval/policy-retrieval.service';
import { AGENT_RUN_REPOSITORY, AgentRunRepository } from '../../src/db/agent-run.repository';
import { TENANT_REPOSITORY, TenantRepository } from '../../src/db/tenant.repository';
import { APPROVAL_REPOSITORY, ApprovalRepository } from '../../src/approvals/approval.repository';
import {
  cleanupTenant,
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

/** Same spy pattern chat.integration-spec.ts's own canary test uses - Logger writes via process.stdout/stderr, never console.*, so spying on Logger.prototype itself is what actually captures everything this run-time logs. */
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

describe.skipIf(!integrationTestsEnabled())('Chat + Approvals (integration, real database)', () => {
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

  function send(publicOrSecretKey: string, body: Record<string, unknown>) {
    return request(app.getHttpServer()).post('/v1/chat').set('Authorization', `Bearer ${publicOrSecretKey}`).send(body);
  }

  function repos(): { agentRun: AgentRunRepository; approval: ApprovalRepository; tenant: TenantRepository } {
    return {
      agentRun: app.get(AGENT_RUN_REPOSITORY),
      approval: app.get(APPROVAL_REPOSITORY),
      tenant: app.get(TENANT_REPOSITORY),
    };
  }

  /** Uploads a tiny real policy doc and polls until it's searchable, returning its chunkKey - every refund-proposal scenario below needs a real citation (refund-verifier rule 8). */
  async function seedCitableChunk(tenant: TenantFixture, text: string): Promise<{ chunkKey: string; uniqueWord: string }> {
    const uniqueWord = `chunk${Date.now()}${Math.random().toString(36).slice(2)}`;
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

  it('out-of-window proposal (ORD-1004, delivered 60 days ago): denied on OUTSIDE_REFUND_WINDOW, no Approval row', async () => {
    const tenant = await newTenant();
    const { kid, privateKey } = await registerCustomerKeyFixture(uri, tenant.tenantId);
    const token = mintCustomerToken(tenant.tenantId, 'cust_2', kid, privateKey);
    const { chunkKey, uniqueWord } = await seedCitableChunk(tenant, 'Orders within the refund window can be refunded.');

    scriptableLlm.setScript([
      planOutput({ needsPolicy: true, searchQuery: uniqueWord, toolRequests: [{ tool: 'get_order', order_id: 'ORD-1004' }] }),
      composeOutput({ outcome: 'propose_refund', message: 'Refunding you.', citedChunkKeys: [chunkKey], proposedRefund: { order_id: 'ORD-1004', amount: 75.25 } }),
    ]);

    const res = await send(tenant.publicKey, { message: 'refund my old order', customerToken: token });

    expect(res.status).toBe(200);
    expect(res.body.outcome).toBe('escalate');
    expect(res.body.proposedAction).toBeUndefined();
    const conversationId = res.body.conversationId as string;

    const { agentRun, approval } = repos();
    const runs = await agentRun.findByConversation(tenant.tenantId, conversationId);
    expect(runs[0].refundDisposition?.kind).toBe('denied');
    expect(runs[0].refundDisposition?.failedRuleCodes).toContain('OUTSIDE_REFUND_WINDOW');
    expect((await approval.list(tenant.tenantId, {})).approvals).toHaveLength(0);
  });

  it('a second proposal for an order with an active approval: already-under-review, no new row, AgentRun points at the SAME approvalId', async () => {
    const tenant = await newTenant();
    const { kid, privateKey } = await registerCustomerKeyFixture(uri, tenant.tenantId);
    const token = mintCustomerToken(tenant.tenantId, 'cust_1', kid, privateKey);
    const { chunkKey, uniqueWord } = await seedCitableChunk(tenant, 'A delivered order that arrived damaged can be refunded.');

    const script = [
      planOutput({ needsPolicy: true, searchQuery: uniqueWord, toolRequests: [{ tool: 'get_order', order_id: 'ORD-1001' }] }),
      composeOutput({ outcome: 'propose_refund', message: 'Refunding you.', citedChunkKeys: [chunkKey], proposedRefund: { order_id: 'ORD-1001', amount: 10 } }),
    ];

    scriptableLlm.setScript(script);
    const first = await send(tenant.publicKey, { message: 'refund please', customerToken: token });
    expect(first.body.outcome).toBe('pending_approval');
    const firstApprovalId = (await repos().agentRun.findByConversation(tenant.tenantId, first.body.conversationId as string))[0].refundDisposition!
      .approvalId;

    scriptableLlm.setScript(script);
    const second = await send(tenant.publicKey, { message: 'refund please again', customerToken: token, conversationId: first.body.conversationId });

    expect(second.status).toBe(200);
    expect(second.body.outcome).toBe('escalate');
    expect(second.body.message).toMatch(/already under review|already.*review/i);

    const { approval, agentRun } = repos();
    expect((await approval.list(tenant.tenantId, {})).approvals).toHaveLength(1); // still just the one row
    const secondRuns = await agentRun.findByConversation(tenant.tenantId, second.body.conversationId as string);
    const secondProposalRun = secondRuns.find((r) => r.refundDisposition?.kind === 'already_pending');
    expect(secondProposalRun?.refundDisposition?.approvalId).toBe(firstApprovalId);
  });

  it('auto-execute ON, amount at or under the approval threshold: the real mock-store refund is issued exactly once, reply (not pending_approval)', async () => {
    // ORD-1008 (cust_5, delivered, $44.00) is used nowhere else in this file - this test is the
    // ONLY one in the whole suite that actually EXECUTES a real refund via the mock store, which
    // mutates that order's alreadyRefundedTotal permanently for the lifetime of the shared
    // in-process mock-store instance (one boot per file, never reset between tests). Reusing
    // ORD-1001 here (as an earlier draft did) silently broke every OTHER test in this file that
    // also proposes against ORD-1001, since each would see it as already-fully-refunded from
    // this point on - a real test-isolation bug, not a product bug (see docs/learning-notes.md).
    const tenant = await newTenant();
    await repos().tenant.updateSettings(tenant.tenantId, { autoExecuteRefunds: true, approvalThreshold: 100, dailyRefundCountLimit: 10 });
    const { kid, privateKey } = await registerCustomerKeyFixture(uri, tenant.tenantId);
    const token = mintCustomerToken(tenant.tenantId, 'cust_5', kid, privateKey);
    const { chunkKey, uniqueWord } = await seedCitableChunk(tenant, 'A delivered order that arrived damaged can be refunded automatically.');

    scriptableLlm.setScript([
      planOutput({ needsPolicy: true, searchQuery: uniqueWord, toolRequests: [{ tool: 'get_order', order_id: 'ORD-1008' }] }),
      composeOutput({ outcome: 'propose_refund', message: 'Refunding you.', citedChunkKeys: [chunkKey], proposedRefund: { order_id: 'ORD-1008', amount: 44.0 } }),
    ]);

    const res = await send(tenant.publicKey, { message: 'refund my damaged order', customerToken: token });

    expect(res.status).toBe(200);
    expect(res.body.outcome).toBe('reply');
    expect(res.body.message).toMatch(/44\.00/);
    expect(res.body.proposedAction).toBeUndefined();

    const { agentRun, approval } = repos();
    const runs = await agentRun.findByConversation(tenant.tenantId, res.body.conversationId as string);
    expect(runs[0].refundDisposition?.kind).toBe('auto_executed');
    const approvalRecord = await approval.findById(tenant.tenantId, runs[0].refundDisposition!.approvalId!);
    expect(approvalRecord).toMatchObject({ status: 'executed', active: false, orderId: 'ORD-1008', amountCents: 4400, decidedBy: 'system:auto_execute' });
  });

  it('auto-execute OFF (tenant default): the SAME scenario stays pending_approval - no refund issued yet', async () => {
    const tenant = await newTenant();
    const { kid, privateKey } = await registerCustomerKeyFixture(uri, tenant.tenantId);
    const token = mintCustomerToken(tenant.tenantId, 'cust_1', kid, privateKey);
    const { chunkKey, uniqueWord } = await seedCitableChunk(tenant, 'A delivered order that arrived damaged can be refunded.');

    scriptableLlm.setScript([
      planOutput({ needsPolicy: true, searchQuery: uniqueWord, toolRequests: [{ tool: 'get_order', order_id: 'ORD-1001' }] }),
      composeOutput({ outcome: 'propose_refund', message: 'Refunding you.', citedChunkKeys: [chunkKey], proposedRefund: { order_id: 'ORD-1001', amount: 49.99 } }),
    ]);

    const res = await send(tenant.publicKey, { message: 'refund my damaged order', customerToken: token });

    expect(res.body.outcome).toBe('pending_approval');
    const { agentRun, approval } = repos();
    const runs = await agentRun.findByConversation(tenant.tenantId, res.body.conversationId as string);
    expect(runs[0].refundDisposition?.kind).toBe('pending_approval');
    const approvalRecord = await approval.findById(tenant.tenantId, runs[0].refundDisposition!.approvalId!);
    expect(approvalRecord?.status).toBe('pending');
  });

  it('once an approval is no longer active (expired), a new proposal for the same order is NOT blocked - gets its own distinct row', async () => {
    // The lazy-expiry PATH itself (amendment F2: a stale pending row past expiresAt is
    // discovered and expired automatically by createApprovalRow's own retry-on-duplicate-key
    // dance) is already proven end to end, including the automatic discovery, by
    // approval.service.spec.ts's own "amendment F2" unit tests - those use a fake clock to
    // actually advance past expiresAt, which a real-wall-clock HTTP integration test can't do in
    // test-speed without waiting a real day. What THIS test proves at the HTTP level: once a row
    // has genuinely left the active set (here, via the same `expire` transition F2's own retry
    // ultimately performs - a real, legitimate state transition, not a fabricated one), a brand
    // new proposal for that same order is never blocked and gets its own distinct approval id -
    // the partial-unique-index-driven "already_pending" case above is specifically about an
    // ACTIVE row, never a terminal one.
    const tenant = await newTenant();
    const { kid, privateKey } = await registerCustomerKeyFixture(uri, tenant.tenantId);
    const token = mintCustomerToken(tenant.tenantId, 'cust_1', kid, privateKey);
    const { chunkKey, uniqueWord } = await seedCitableChunk(tenant, 'A delivered order that arrived damaged can be refunded.');

    const script = () => [
      planOutput({ needsPolicy: true, searchQuery: uniqueWord, toolRequests: [{ tool: 'get_order', order_id: 'ORD-1001' }] }),
      composeOutput({ outcome: 'propose_refund', message: 'Refunding you.', citedChunkKeys: [chunkKey], proposedRefund: { order_id: 'ORD-1001', amount: 10 } }),
    ];

    scriptableLlm.setScript(script());
    const first = await send(tenant.publicKey, { message: 'refund please', customerToken: token });
    const firstApprovalId = (await repos().agentRun.findByConversation(tenant.tenantId, first.body.conversationId as string))[0].refundDisposition!
      .approvalId!;

    await repos().approval.expire(tenant.tenantId, firstApprovalId, new Date(Date.now() + 10 * 365 * 24 * 60 * 60 * 1000));
    const stillActive = await repos().approval.findActiveByOrder(tenant.tenantId, 'ORD-1001');
    expect(stillActive).toBeNull();

    scriptableLlm.setScript(script());
    const second = await send(tenant.publicKey, { message: 'refund please again', customerToken: token, conversationId: first.body.conversationId });

    expect(second.body.outcome).toBe('pending_approval');
    const secondApprovalId = (await repos().agentRun.findByConversation(tenant.tenantId, second.body.conversationId as string)).find(
      (r) => r.refundDisposition?.kind === 'pending_approval',
    )?.refundDisposition?.approvalId;
    expect(secondApprovalId).not.toBe(firstApprovalId);
  });

  it('tenant isolation: two tenants proposing refunds for the same order id never see each others Approval rows', async () => {
    const tenantA = await newTenant();
    const tenantB = await newTenant();
    const { kid: kidA, privateKey: pkA } = await registerCustomerKeyFixture(uri, tenantA.tenantId);
    const { kid: kidB, privateKey: pkB } = await registerCustomerKeyFixture(uri, tenantB.tenantId);
    const tokenA = mintCustomerToken(tenantA.tenantId, 'cust_1', kidA, pkA);
    const tokenB = mintCustomerToken(tenantB.tenantId, 'cust_1', kidB, pkB);
    const chunkA = await seedCitableChunk(tenantA, 'A delivered order that arrived damaged can be refunded.');
    const chunkB = await seedCitableChunk(tenantB, 'A delivered order that arrived damaged can be refunded.');

    scriptableLlm.setScript([
      planOutput({ needsPolicy: true, searchQuery: chunkA.uniqueWord, toolRequests: [{ tool: 'get_order', order_id: 'ORD-1001' }] }),
      composeOutput({ outcome: 'propose_refund', message: 'Refunding you.', citedChunkKeys: [chunkA.chunkKey], proposedRefund: { order_id: 'ORD-1001', amount: 10 } }),
    ]);
    const resA = await send(tenantA.publicKey, { message: 'refund please', customerToken: tokenA });
    expect(resA.body.outcome).toBe('pending_approval');

    scriptableLlm.setScript([
      planOutput({ needsPolicy: true, searchQuery: chunkB.uniqueWord, toolRequests: [{ tool: 'get_order', order_id: 'ORD-1001' }] }),
      composeOutput({ outcome: 'propose_refund', message: 'Refunding you.', citedChunkKeys: [chunkB.chunkKey], proposedRefund: { order_id: 'ORD-1001', amount: 10 } }),
    ]);
    const resB = await send(tenantB.publicKey, { message: 'refund please', customerToken: tokenB });
    expect(resB.body.outcome).toBe('pending_approval'); // tenant B's own proposal for the "same" order id is NOT blocked by tenant A's

    const { approval } = repos();
    expect((await approval.list(tenantA.tenantId, {})).approvals).toHaveLength(1);
    expect((await approval.list(tenantB.tenantId, {})).approvals).toHaveLength(1);
    const approvalIdA = (await repos().agentRun.findByConversation(tenantA.tenantId, resA.body.conversationId as string))[0].refundDisposition!
      .approvalId!;
    expect(await approval.findById(tenantB.tenantId, approvalIdA)).toBeNull(); // cross-tenant lookup of tenant A's own row fails
  });

  it('an anonymous caller (no customer token) can never produce any refund disposition at all - order-scoped tools are structurally unavailable', async () => {
    const tenant = await newTenant();

    scriptableLlm.setScript([
      planOutput({ needsPolicy: false, toolRequests: [{ tool: 'get_order', order_id: 'ORD-1001' }] }), // the model TRIES - code must refuse regardless
      composeOutput({ outcome: 'clarify', message: 'Which order?' }),
    ]);

    const res = await send(tenant.publicKey, { message: 'refund my order please' });

    expect(res.status).toBe(200);
    expect(res.body.outcome).not.toBe('pending_approval');
    expect((await repos().approval.list(tenant.tenantId, {})).approvals).toHaveLength(0);
  });

  it('canary string through the refund-proposal path: never appears in any Logger output, including the escalation/approval event lines', async () => {
    const tenant = await newTenant();
    const { kid, privateKey } = await registerCustomerKeyFixture(uri, tenant.tenantId);
    const token = mintCustomerToken(tenant.tenantId, 'cust_1', kid, privateKey);
    const canary = canaryString();
    const logSpy = spyOnLoggerOutput();

    scriptableLlm.setScript([
      planOutput({ reasoning: `about ${canary}`, toolRequests: [{ tool: 'get_order', order_id: 'ORD-1001' }] }),
      composeOutput({ outcome: 'propose_refund', message: `Refunding you, re: ${canary}.`, citedChunkKeys: [], proposedRefund: { order_id: 'ORD-1001', amount: 10 } }),
    ]);

    const res = await send(tenant.publicKey, { message: `refund me, ${canary}`, customerToken: token });
    expect(res.status).toBe(200);

    for (const line of logSpy.lines) {
      expect(line).not.toContain(canary);
    }
    logSpy.restore();
  });
});
