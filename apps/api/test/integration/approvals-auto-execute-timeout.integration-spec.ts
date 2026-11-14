/**
 * Milestone 4 Stage 5 follow-up H1(b) - an ambiguous upstream failure
 * (timeout) during auto-execute, against a real live chat request: the
 * `issue_refund` connector is pointed at a stub server (same
 * `startStubServer` pattern as the tool-runner's own specs) that accepts
 * the connection and never answers, so the REAL connector timeout
 * (`CONNECTOR_REQUEST_TIMEOUT_MS`) fires. Everything else (get_order,
 * track_shipment, escalate_to_human) stays pointed at the real in-process
 * mock store.
 *
 * `ApprovalService` is reached directly via `app.get(ApprovalService)`
 * (Nest's own non-strict `get()` ignores module export boundaries - the
 * same convenience this suite already relies on for `PolicyRetrievalService`
 * etc.) to perform the retry decision, standing in for the admin
 * `POST /v1/approvals/:id/decision` route Stage 6 has not built yet.
 */
import './test-env';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ComposeOutput, PlannerOutput } from '@supportpilot/shared';
import { AppModule } from '../../src/app.module';
import { LLM_PROVIDER } from '../../src/llm/llm.module';
import { GenerateOutcome } from '../../src/llm/llm-provider.interface';
import { PolicyRetrievalService } from '../../src/retrieval/policy-retrieval.service';
import { GENERIC_ESCALATE_MESSAGE } from '../../src/agent/loop/run-agent';
import { ApprovalService } from '../../src/approvals/approval.service';
import { APPROVAL_REPOSITORY, ApprovalRepository } from '../../src/approvals/approval.repository';
import { AGENT_RUN_REPOSITORY, AgentRunRepository } from '../../src/db/agent-run.repository';
import { TENANT_REPOSITORY, TenantRepository } from '../../src/db/tenant.repository';
import { cleanupTenant, createTenantFixture, disconnectFixtureConnection } from './tenant-fixture';
import { getTestMongoUri, integrationTestsEnabled } from './test-env';
import { pollUntil } from './poll';
import { startStubServer, StubServer } from '../../src/agent/tool-runner/test-utils/stub-server';
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

/** Rewrites ONLY issue_refund.json's request.baseUrl, in place, without touching the other three tool fixtures writeAcmeConnectorFixtures already wrote for this tenant. */
async function pointIssueRefundAt(tempConnectorRoot: string, tenantId: string, baseUrl: string): Promise<void> {
  const path = join(tempConnectorRoot, tenantId, 'issue_refund.json');
  const raw = await readFile(path, 'utf8');
  const config = JSON.parse(raw) as Record<string, unknown>;
  config.request = { ...(config.request as Record<string, unknown>), baseUrl };
  await writeFile(path, JSON.stringify(config, null, 2), 'utf8');
}

describe.skipIf(!integrationTestsEnabled())('Auto-execute timeout: an ambiguous upstream failure, then a healthy retry (integration, real database)', () => {
  let app: INestApplication;
  let mockStore: MockStoreHandle;
  let stub: StubServer;
  let tempConnectorRoot: string;
  let scriptableLlm: ScriptableLlmProvider;
  const createdTenants: string[] = [];

  beforeAll(async () => {
    mockStore = await startMockStore();
    stub = await startStubServer(() => {
      /* never responds - the upstream accepts the connection and then goes silent */
    });
    tempConnectorRoot = await makeTempConnectorRoot();

    process.env.NODE_ENV = 'test';
    process.env.ALLOW_PRIVATE_NETWORKS = 'true';
    process.env.CONNECTOR_HOST_ALLOWLIST = `127.0.0.1:${new URL(mockStore.baseUrl).port},127.0.0.1:${stub.port}`;
    process.env.CONNECTOR_CONFIG_DIR = tempConnectorRoot;
    process.env[CONNECTOR_SECRET_ENV_VAR] = MOCK_STORE_TOKEN;
    // Short enough that the test doesn't hang for 5s (the tool runner's own default) waiting on
    // the stub, comfortably inside AUTO_EXECUTE_TIMEOUT_MS's own default (15s) so the TOOL-level
    // timeout fires first and is classified correctly (AMBIGUOUS, not the outer bound firing).
    process.env.CONNECTOR_REQUEST_TIMEOUT_MS = '500';

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
    delete process.env.CONNECTOR_REQUEST_TIMEOUT_MS;

    await Promise.all(createdTenants.map((tenantId) => cleanupTenant(uri, tenantId)));
    await app.close();
    await mockStore.close();
    await stub.close();
    await removeTempConnectorRoot(tempConnectorRoot);
    await disconnectFixtureConnection();
  });

  it('customer gets the generic escalate message (never a success claim); Approval is failed+retryable+upstreamMaybeReceived; a later retry against a healthy upstream reuses the SAME idempotency key and issues exactly one refund', async () => {
    const tenant = await createTenantFixture(uri);
    createdTenants.push(tenant.tenantId);
    await writeAcmeConnectorFixtures(tempConnectorRoot, tenant.tenantId, mockStore.baseUrl);
    await pointIssueRefundAt(tempConnectorRoot, tenant.tenantId, stub.url); // issue_refund ONLY now points at the hanging stub

    const tenantRepo = app.get<TenantRepository>(TENANT_REPOSITORY);
    await tenantRepo.updateSettings(tenant.tenantId, { autoExecuteRefunds: true, approvalThreshold: 100, dailyRefundCountLimit: 10 });

    const { kid, privateKey } = await registerCustomerKeyFixture(uri, tenant.tenantId);
    const token = mintCustomerToken(tenant.tenantId, 'cust_1', kid, privateKey);

    const uniqueWord = `timeoutlexeme${Date.now()}`;
    const uploadRes = await request(app.getHttpServer())
      .post('/v1/policies')
      .set('Authorization', `Bearer ${tenant.secretKey}`)
      .attach('file', Buffer.from(`# Policy\n\nA delivered order that arrived damaged can be refunded automatically. ${uniqueWord}.`), 'policy.md')
      .field('title', 'Policy');
    const documentId = uploadRes.body.id as string;
    const retrievalService = app.get(PolicyRetrievalService);
    const found = await pollUntil(async () => {
      const r = await retrievalService.retrieve(tenant.tenantId, uniqueWord);
      return r.ok && r.results.some((x) => x.documentId === documentId) ? r.results.find((x) => x.documentId === documentId) : undefined;
    }, `tenant ${tenant.tenantId}'s policy chunk becoming searchable for "${uniqueWord}"`);
    const chunkKey = found!.chunkKey;

    scriptableLlm.setScript([
      planOutput({ needsPolicy: true, searchQuery: uniqueWord, toolRequests: [{ tool: 'get_order', order_id: 'ORD-1001' }] }),
      composeOutput({ outcome: 'propose_refund', message: 'Refunding you.', citedChunkKeys: [chunkKey], proposedRefund: { order_id: 'ORD-1001', amount: 10 } }),
    ]);

    const res = await request(app.getHttpServer())
      .post('/v1/chat')
      .set('Authorization', `Bearer ${tenant.publicKey}`)
      .send({ message: 'refund my damaged order', customerToken: token });

    expect(res.status).toBe(200);
    expect(res.body.outcome).toBe('escalate');
    expect(res.body.message).toBe(GENERIC_ESCALATE_MESSAGE); // never a success claim
    expect(res.body.proposedAction).toBeUndefined();

    const agentRunRepo = app.get<AgentRunRepository>(AGENT_RUN_REPOSITORY);
    const runs = await agentRunRepo.findByConversation(tenant.tenantId, res.body.conversationId as string);
    const approvalId = runs[0].refundDisposition!.approvalId!;

    const approvalRepo = app.get<ApprovalRepository>(APPROVAL_REPOSITORY);
    const failedApproval = await approvalRepo.findById(tenant.tenantId, approvalId);
    expect(failedApproval).toMatchObject({
      status: 'failed',
      retryable: true,
      active: true,
      upstreamMaybeReceived: true,
      orderId: 'ORD-1001',
    });
    const originalIdempotencyKey = failedApproval!.idempotencyKey;

    // Now point issue_refund at the REAL, responsive mock store - "a later retry with a
    // responsive upstream". FileConnectorConfigRepository reads the filesystem live on every
    // call, so this takes effect on the very next tool call, no app restart needed.
    await pointIssueRefundAt(tempConnectorRoot, tenant.tenantId, mockStore.baseUrl);

    // Stand-in for the admin POST /v1/approvals/:id/decision route (Stage 6, not built yet) -
    // app.get() ignores module export boundaries (the same convenience this suite already uses
    // for PolicyRetrievalService), so this reaches the real ApprovalService directly.
    const approvalService = app.get(ApprovalService);
    const retryResult = await approvalService.decide(
      tenant.tenantId,
      approvalId,
      'approve',
      'test-harness-retry',
      new Date(),
      { refundCap: 2000, approvalThreshold: 100, refundWindowDays: 30, autoExecuteRefunds: true }, // unused on a retry (amendment A - no re-verification)
      async () => null, // unused on a retry, same reason
    );

    expect(retryResult.ok).toBe(true);
    expect(retryResult.ok && retryResult.status).toBe('executed');

    const executedApproval = await approvalRepo.findById(tenant.tenantId, approvalId);
    expect(executedApproval).toMatchObject({ status: 'executed', active: false });
    expect(executedApproval!.idempotencyKey).toBe(originalIdempotencyKey); // the SAME key both times

    // Exactly one refund actually happened - confirmed directly against the mock store's own
    // ledger (bypassing the connector layer entirely), never doubled by the retry.
    const orderAfter = await fetch(`${mockStore.baseUrl}/orders/ORD-1001`, { headers: { Authorization: `Bearer ${MOCK_STORE_TOKEN}` } });
    const orderBody = (await orderAfter.json()) as { alreadyRefundedTotal: number };
    expect(orderBody.alreadyRefundedTotal).toBe(10);
  }, 30_000);
});
