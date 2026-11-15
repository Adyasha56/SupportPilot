/**
 * Milestone 4 Stage 6 - two decision-flow edge states that are far simpler
 * to prove deterministically by fabricating the Approval document directly
 * (same technique approvals-admin-api.integration-spec.ts's own expiry test
 * uses for expiresAt) than by racing a real upstream timeout inside one
 * synchronous HTTP request:
 *
 *  - "stuck executing, taken over only after the lease": a real
 *    crash-mid-execution (the only way a row is genuinely left in
 *    'executing' with nobody resolving it) can't be reproduced by a client
 *    racing its own request, since this project's whole execution step runs
 *    synchronously inside one admin decide() call. Writing the document
 *    directly into that state is an honest stand-in for "the process died
 *    after beginExecution but before markExecuted/markFailed landed" -
 *    exactly the case the lease exists for.
 *  - "reject blocked after an ambiguous failure": fabricates a
 *    failed+retryable+AMBIGUOUS row directly, the same shape
 *    classify-refund-execution-failure.ts would have produced from a real
 *    timeout - refund-execution-classification.spec.ts and
 *    approvals-auto-execute-timeout.integration-spec.ts already prove that
 *    shape is what a real ambiguous failure actually looks like; this file
 *    only needs to prove what the DECISION route does once a row is in it.
 */
import './test-env';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { getModelToken } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import { ComposeOutput, PlannerOutput } from '@supportpilot/shared';
import { AppModule } from '../../src/app.module';
import { LLM_PROVIDER } from '../../src/llm/llm.module';
import { GenerateOutcome } from '../../src/llm/llm-provider.interface';
import { PolicyRetrievalService } from '../../src/retrieval/policy-retrieval.service';
import { AGENT_RUN_REPOSITORY, AgentRunRepository } from '../../src/db/agent-run.repository';
import { APPROVAL_EXECUTION_LEASE_MS_DEFAULT } from '../../src/approvals/approval.service';
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

describe.skipIf(!integrationTestsEnabled())('Admin decision route: fenced states (integration, real database)', () => {
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

  async function proposeRefund(tenant: TenantFixture, orderId: string, amount: number, customerRef: string): Promise<string> {
    const { kid, privateKey } = await registerCustomerKeyFixture(uri, tenant.tenantId);
    const token = mintCustomerToken(tenant.tenantId, customerRef, kid, privateKey);

    const uniqueWord = `fenced${Date.now()}${Math.random().toString(36).slice(2)}`;
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
      planOutput({ needsPolicy: true, searchQuery: uniqueWord, toolRequests: [{ tool: 'get_order', order_id: orderId }] }),
      composeOutput({ outcome: 'propose_refund', message: 'Refunding you.', citedChunkKeys: [chunkKey], proposedRefund: { order_id: orderId, amount } }),
    ]);
    const res = await request(app.getHttpServer())
      .post('/v1/chat')
      .set('Authorization', `Bearer ${tenant.publicKey}`)
      .send({ message: 'refund my damaged order', customerToken: token });
    expect(res.body.outcome).toBe('pending_approval');

    const agentRunRepo = app.get<AgentRunRepository>(AGENT_RUN_REPOSITORY);
    const runs = await agentRunRepo.findByConversation(tenant.tenantId, res.body.conversationId as string);
    return runs[0].refundDisposition!.approvalId!;
  }

  function decide(adminKey: string, approvalId: string, body: Record<string, unknown>) {
    return request(app.getHttpServer()).post(`/v1/approvals/${approvalId}/decision`).set('Authorization', `Bearer ${adminKey}`).send(body);
  }

  it('executing within the lease: 409 IN_PROGRESS, no upstream call; past the lease: an atomic takeover lets the retry actually execute', async () => {
    const tenant = await newTenant();
    const adminKey = (await createApiKeyFixture(uri, tenant.tenantId, 'admin')).rawKey;
    const approvalId = await proposeRefund(tenant, 'ORD-1001', 10, 'cust_1'); // a separate mock-store boot from approvals-admin-api's own file, so reusing ORD-1001 here is safe

    const approvalModel = app.get<Model<ApprovalDocument>>(getModelToken('Approval'));
    const now = new Date();
    await approvalModel.updateOne(
      { _id: approvalId },
      { $set: { status: 'executing', executingSince: now, executionStartedAt: now, attemptCount: 1 } },
    );

    const withinLease = await decide(adminKey, approvalId, { decision: 'approve' });
    expect(withinLease.status).toBe(409);
    expect(withinLease.body.code).toBe('IN_PROGRESS');

    const orderDuringLease = await fetch(`${mockStore.baseUrl}/orders/ORD-1001`, { headers: { Authorization: `Bearer ${MOCK_STORE_TOKEN}` } });
    expect(((await orderDuringLease.json()) as { alreadyRefundedTotal: number }).alreadyRefundedTotal).toBe(0); // no upstream call was made

    // Backdate executingSince past the lease - the only thing distinguishing "still owned by a
    // live attempt" from "stuck, nobody is coming back to it" in this project's design.
    await approvalModel.updateOne(
      { _id: approvalId },
      { $set: { executingSince: new Date(Date.now() - APPROVAL_EXECUTION_LEASE_MS_DEFAULT - 1000) } },
    );

    const afterLease = await decide(adminKey, approvalId, { decision: 'approve' });
    expect(afterLease.status).toBe(200);
    expect(afterLease.body.status).toBe('executed');

    const orderAfter = await fetch(`${mockStore.baseUrl}/orders/ORD-1001`, { headers: { Authorization: `Bearer ${MOCK_STORE_TOKEN}` } });
    expect(((await orderAfter.json()) as { alreadyRefundedTotal: number }).alreadyRefundedTotal).toBe(10);
  });

  it('reject is blocked on a failed+AMBIGUOUS row: 409 AMBIGUOUS_RETRY_REQUIRED, never a false "we decided not to refund"', async () => {
    const tenant = await newTenant();
    const adminKey = (await createApiKeyFixture(uri, tenant.tenantId, 'admin')).rawKey;
    const approvalId = await proposeRefund(tenant, 'ORD-1006', 500, 'cust_3');

    const approvalModel = app.get<Model<ApprovalDocument>>(getModelToken('Approval'));
    await approvalModel.updateOne(
      { _id: approvalId },
      {
        $set: {
          status: 'failed',
          retryable: true,
          active: true,
          failureClass: 'AMBIGUOUS',
          upstreamMaybeReceived: true,
          executionResultCode: 'TIMEOUT',
          attemptCount: 1,
        },
      },
    );

    const res = await decide(adminKey, approvalId, { decision: 'reject', reasonCode: 'OTHER' });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('AMBIGUOUS_RETRY_REQUIRED');

    const getRes = await request(app.getHttpServer()).get(`/v1/approvals/${approvalId}`).set('Authorization', `Bearer ${adminKey}`);
    expect(getRes.body.status).toBe('failed'); // never flipped to rejected
  });
});
