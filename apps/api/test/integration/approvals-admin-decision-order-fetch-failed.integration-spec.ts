/**
 * Milestone 4 Stage 6 follow-up - the decision-time fresh-order re-check
 * (amendment A) itself failing to even fetch, not the order being
 * ineligible. `get_order`'s connector is pointed at a stub that accepts the
 * connection and never answers (same `startStubServer` pattern
 * approvals-auto-execute-timeout.integration-spec.ts already uses for
 * `issue_refund`), so the real connector timeout fires. Per
 * fetch-fresh-order-snapshot.ts's own discriminated result, any code other
 * than the tool runner's explicit NOT_FOUND maps to `reason: 'FETCH_FAILED'`
 * - approveFromPending must then return `ORDER_FETCH_FAILED` with NO state
 * change at all (the row stays exactly 'pending'), never guess ineligibility
 * from a fetch it never actually completed, and never proceed to
 * beginExecution/the privileged runner.
 */
import './test-env';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ComposeOutput, PlannerOutput } from '@supportpilot/shared';
import { AppModule } from '../../src/app.module';
import { LLM_PROVIDER } from '../../src/llm/llm.module';
import { GenerateOutcome } from '../../src/llm/llm-provider.interface';
import { PolicyRetrievalService } from '../../src/retrieval/policy-retrieval.service';
import { AGENT_RUN_REPOSITORY, AgentRunRepository } from '../../src/db/agent-run.repository';
import { APPROVAL_REPOSITORY, ApprovalRepository } from '../../src/approvals/approval.repository';
import { startStubServer, StubServer } from '../../src/agent/tool-runner/test-utils/stub-server';
import { cleanupTenant, createApiKeyFixture, createTenantFixture, disconnectFixtureConnection } from './tenant-fixture';
import { getTestMongoUri, integrationTestsEnabled } from './test-env';
import { pollUntil } from './poll';
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

/** Rewrites ONLY get_order.json's request.baseUrl, in place - mirrors approvals-auto-execute-timeout's own pointIssueRefundAt, aimed at the other tool. */
async function pointGetOrderAt(tempConnectorRoot: string, tenantId: string, baseUrl: string): Promise<void> {
  const path = join(tempConnectorRoot, tenantId, 'get_order.json');
  const raw = await readFile(path, 'utf8');
  const config = JSON.parse(raw) as Record<string, unknown>;
  config.request = { ...(config.request as Record<string, unknown>), baseUrl };
  await writeFile(path, JSON.stringify(config, null, 2), 'utf8');
}

describe.skipIf(!integrationTestsEnabled())('Admin decision route: the fresh order fetch itself fails (integration, real database)', () => {
  let app: INestApplication;
  let mockStore: MockStoreHandle;
  let stub: StubServer;
  let tempConnectorRoot: string;
  let scriptableLlm: ScriptableLlmProvider;
  const uri = integrationTestsEnabled() ? getTestMongoUri() : '';
  const createdTenants: string[] = [];

  beforeAll(async () => {
    mockStore = await startMockStore();
    stub = await startStubServer(() => {
      /* never responds - standing in for a dead/unreachable order-lookup connector */
    });
    tempConnectorRoot = await makeTempConnectorRoot();

    process.env.NODE_ENV = 'test';
    process.env.ALLOW_PRIVATE_NETWORKS = 'true';
    process.env.CONNECTOR_HOST_ALLOWLIST = `127.0.0.1:${new URL(mockStore.baseUrl).port},127.0.0.1:${stub.port}`;
    process.env.CONNECTOR_CONFIG_DIR = tempConnectorRoot;
    process.env[CONNECTOR_SECRET_ENV_VAR] = MOCK_STORE_TOKEN;
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

  it('502 ORDER_FETCH_FAILED, the approval is left exactly as it was (still pending), and no upstream issue_refund call is ever made', async () => {
    const tenant = await createTenantFixture(uri);
    createdTenants.push(tenant.tenantId);
    await writeAcmeConnectorFixtures(tempConnectorRoot, tenant.tenantId, mockStore.baseUrl);
    const adminKey = (await createApiKeyFixture(uri, tenant.tenantId, 'admin')).rawKey;
    const { kid, privateKey } = await registerCustomerKeyFixture(uri, tenant.tenantId);
    const token = mintCustomerToken(tenant.tenantId, 'cust_1', kid, privateKey);

    // Propose normally FIRST, while get_order still points at the real, healthy mock store - the
    // proposal-time verifier must pass so this reaches a real pending Approval.
    const uniqueWord = `fetchfail${Date.now()}`;
    const uploadRes = await request(app.getHttpServer())
      .post('/v1/policies')
      .set('Authorization', `Bearer ${tenant.secretKey}`)
      .attach('file', Buffer.from(`# Policy\n\nA delivered order that arrived damaged can be refunded. ${uniqueWord}.`), 'policy.md')
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
    const chatRes = await request(app.getHttpServer())
      .post('/v1/chat')
      .set('Authorization', `Bearer ${tenant.publicKey}`)
      .send({ message: 'refund my damaged order', customerToken: token });
    expect(chatRes.body.outcome).toBe('pending_approval');

    const agentRunRepo = app.get<AgentRunRepository>(AGENT_RUN_REPOSITORY);
    const runs = await agentRunRepo.findByConversation(tenant.tenantId, chatRes.body.conversationId as string);
    const approvalId = runs[0].refundDisposition!.approvalId!;

    // NOW point get_order at the hanging stub - only the decision-time re-fetch is affected;
    // the approval itself was already created against real, healthy data.
    await pointGetOrderAt(tempConnectorRoot, tenant.tenantId, stub.url);

    const res = await request(app.getHttpServer())
      .post(`/v1/approvals/${approvalId}/decision`)
      .set('Authorization', `Bearer ${adminKey}`)
      .send({ decision: 'approve' });

    expect(res.status).toBe(502);
    expect(res.body.code).toBe('ORDER_FETCH_FAILED');

    const approvalRepo = app.get<ApprovalRepository>(APPROVAL_REPOSITORY);
    const stillPending = await approvalRepo.findById(tenant.tenantId, approvalId);
    expect(stillPending?.status).toBe('pending'); // no state change at all - never escalated to 'executing' or 'failed'
    expect(stillPending?.attemptCount).toBe(0); // beginExecution was never even reached

    const orderRes = await fetch(`${mockStore.baseUrl}/orders/ORD-1001`, { headers: { Authorization: `Bearer ${MOCK_STORE_TOKEN}` } });
    expect(((await orderRes.json()) as { alreadyRefundedTotal: number }).alreadyRefundedTotal).toBe(0); // no upstream issue_refund call was ever made

    // Recovery: point get_order back at the real store - the SAME approval, untouched, is still
    // fully decidable, proving "no state change" really did mean no state change.
    await pointGetOrderAt(tempConnectorRoot, tenant.tenantId, mockStore.baseUrl);
    const retry = await request(app.getHttpServer())
      .post(`/v1/approvals/${approvalId}/decision`)
      .set('Authorization', `Bearer ${adminKey}`)
      .send({ decision: 'approve' });
    expect(retry.status).toBe(200);
    expect(retry.body.status).toBe('executed');
  }, 30_000);
});
