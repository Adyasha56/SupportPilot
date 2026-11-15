/**
 * Milestone 4 Stage 6 - "a markExecuted write failure after a successful
 * refund is reconciled by a later retry" (repository wrapper), at the real
 * HTTP admin-route level. `FlakyMarkExecutedApprovalRepository` wraps the
 * real APPROVAL_REPOSITORY and throws on markExecuted exactly once for a
 * specific, test-armed approval id - simulating a genuine write failure
 * (e.g. a Mongo write timeout) that happens AFTER the real upstream refund
 * already succeeded, never a "fenced out, already recorded elsewhere" null
 * (that distinct case is already covered by approval.service.spec.ts's own
 * amendment F1 unit tests). Because the thrown error propagates uncaught
 * past executeApproval/approveFromPending/decide, the admin's first HTTP
 * response here is a bare 500 - this project draws no {statusCode, code,
 * message} contract around a genuinely unexpected infrastructure fault at
 * this exact point, by design (see approval.service.ts's own executeApproval
 * doc comment: a fenced NULL is handled, a THROW is not swallowed).
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
import {
  APPROVAL_REPOSITORY,
  ApprovalListQuery,
  ApprovalListResult,
  ApprovalRecord,
  ApprovalRepository,
  MongooseApprovalRepository,
  NewApproval,
} from '../../src/approvals/approval.repository';
import { ApprovalDocument } from '../../src/approvals/schemas/approval.schema';
import { APPROVAL_EXECUTION_LEASE_MS_DEFAULT } from '../../src/approvals/approval.service';
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

const uri = integrationTestsEnabled() ? getTestMongoUri() : '';

/** Only markExecuted ever fails, and only once, for an id the test explicitly arms - every other method (including every OTHER call to markExecuted) delegates straight to the real repository. */
class FlakyMarkExecutedApprovalRepository implements ApprovalRepository {
  private readonly armedOnce = new Set<string>();
  constructor(private readonly real: ApprovalRepository) {}

  armNextMarkExecutedFailure(approvalId: string): void {
    this.armedOnce.add(approvalId);
  }

  async markExecuted(tenantId: string, id: string, expectedAttemptCount: number, now: Date): Promise<ApprovalRecord | null> {
    if (this.armedOnce.has(id)) {
      this.armedOnce.delete(id);
      throw new Error('simulated markExecuted persistence failure (the refund itself already succeeded)');
    }
    return this.real.markExecuted(tenantId, id, expectedAttemptCount, now);
  }

  create(input: NewApproval, session?: unknown): Promise<ApprovalRecord> {
    return this.real.create(input, session);
  }
  findById(tenantId: string, id: string): Promise<ApprovalRecord | null> {
    return this.real.findById(tenantId, id);
  }
  findActiveByOrder(tenantId: string, orderId: string): Promise<ApprovalRecord | null> {
    return this.real.findActiveByOrder(tenantId, orderId);
  }
  findByRunId(tenantId: string, runId: string): Promise<ApprovalRecord | null> {
    return this.real.findByRunId(tenantId, runId);
  }
  list(tenantId: string, query: ApprovalListQuery): Promise<ApprovalListResult> {
    return this.real.list(tenantId, query);
  }
  countForCustomerToday(tenantId: string, customerRef: string, now: Date): Promise<number> {
    return this.real.countForCustomerToday(tenantId, customerRef, now);
  }
  beginExecution(...args: Parameters<ApprovalRepository['beginExecution']>): ReturnType<ApprovalRepository['beginExecution']> {
    return this.real.beginExecution(...args);
  }
  takeOverStuckExecution(...args: Parameters<ApprovalRepository['takeOverStuckExecution']>): ReturnType<ApprovalRepository['takeOverStuckExecution']> {
    return this.real.takeOverStuckExecution(...args);
  }
  retryFromFailed(...args: Parameters<ApprovalRepository['retryFromFailed']>): ReturnType<ApprovalRepository['retryFromFailed']> {
    return this.real.retryFromFailed(...args);
  }
  markFailed(...args: Parameters<ApprovalRepository['markFailed']>): ReturnType<ApprovalRepository['markFailed']> {
    return this.real.markFailed(...args);
  }
  reject(...args: Parameters<ApprovalRepository['reject']>): ReturnType<ApprovalRepository['reject']> {
    return this.real.reject(...args);
  }
  expire(...args: Parameters<ApprovalRepository['expire']>): ReturnType<ApprovalRepository['expire']> {
    return this.real.expire(...args);
  }
}

describe.skipIf(!integrationTestsEnabled())('markExecuted write failure, reconciled by a later retry (integration, real database)', () => {
  let app: INestApplication;
  let mockStore: MockStoreHandle;
  let tempConnectorRoot: string;
  let scriptableLlm: ScriptableLlmProvider;
  let flakyRepo: FlakyMarkExecutedApprovalRepository;
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
      .overrideProvider(APPROVAL_REPOSITORY)
      .useFactory({
        inject: [getModelToken('Approval')],
        factory: (model: Model<ApprovalDocument>) => {
          flakyRepo = new FlakyMarkExecutedApprovalRepository(new MongooseApprovalRepository(model));
          return flakyRepo;
        },
      })
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

  it('the real refund happens once; the first decide() attempt crashes recording it; a later retry (after the lease) reconciles, without a second refund', async () => {
    const tenant = await createTenantFixture(uri);
    createdTenants.push(tenant.tenantId);
    await writeAcmeConnectorFixtures(tempConnectorRoot, tenant.tenantId, mockStore.baseUrl);
    const adminKey = (await createApiKeyFixture(uri, tenant.tenantId, 'admin')).rawKey;
    const { kid, privateKey } = await registerCustomerKeyFixture(uri, tenant.tenantId);
    const token = mintCustomerToken(tenant.tenantId, 'cust_1', kid, privateKey);

    const uniqueWord = `reconcile${Date.now()}`;
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

    flakyRepo.armNextMarkExecutedFailure(approvalId);

    const firstAttempt = await request(app.getHttpServer()).post(`/v1/approvals/${approvalId}/decision`).set('Authorization', `Bearer ${adminKey}`).send({ decision: 'approve' });
    expect(firstAttempt.status).toBe(500); // an unexpected infra fault, never this project's own error shape

    const orderAfterFirstAttempt = await fetch(`${mockStore.baseUrl}/orders/ORD-1001`, { headers: { Authorization: `Bearer ${MOCK_STORE_TOKEN}` } });
    expect(((await orderAfterFirstAttempt.json()) as { alreadyRefundedTotal: number }).alreadyRefundedTotal).toBe(10); // the real refund DID happen

    const approvalModel = app.get<Model<ApprovalDocument>>(getModelToken('Approval'));
    const stillExecuting = await approvalModel.findById(approvalId).lean();
    expect(stillExecuting?.status).toBe('executing'); // the write failure never landed - the record was never falsely marked executed

    // Backdate past the lease so the admin's later retry can actually take the row over.
    await approvalModel.updateOne({ _id: approvalId }, { $set: { executingSince: new Date(Date.now() - APPROVAL_EXECUTION_LEASE_MS_DEFAULT - 1000) } });

    const retry = await request(app.getHttpServer()).post(`/v1/approvals/${approvalId}/decision`).set('Authorization', `Bearer ${adminKey}`).send({ decision: 'approve' });
    expect(retry.status).toBe(200);
    expect(retry.body.status).toBe('executed');

    const orderAfterRetry = await fetch(`${mockStore.baseUrl}/orders/ORD-1001`, { headers: { Authorization: `Bearer ${MOCK_STORE_TOKEN}` } });
    expect(((await orderAfterRetry.json()) as { alreadyRefundedTotal: number }).alreadyRefundedTotal).toBe(10); // still just the one refund - the idempotent replay never doubled it
  });
});
