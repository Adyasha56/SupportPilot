/**
 * Milestone 4 Stage 5 follow-up H1(a) - the dual-write transaction (Approval
 * insert + AgentRun insert, sharing one Mongo session via
 * ApprovalService.createApprovalRow's `attemptTransactional`) genuinely
 * failing against a REAL Mongo session, in both directions: the AgentRun
 * write failing (wrapping AGENT_RUN_REPOSITORY), and the Approval write
 * failing (wrapping APPROVAL_REPOSITORY, the mirror case). Each gets its
 * own app instance (a different provider is overridden in each), same
 * "repository wrapper over the real one" pattern chat-limits.integration-
 * spec.ts's own FailingCreateAgentRunRepository already established for
 * the Milestone 3 (non-transactional) case - every OTHER collection in
 * both describe blocks below is the real thing, never a full-DB mock.
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
import { AGENT_RUN_REPOSITORY, AgentRunRecord, AgentRunRepository, MongooseAgentRunRepository, NewAgentRun } from '../../src/db/agent-run.repository';
import { AgentRunDocument } from '../../src/db/schemas/agent-run.schema';
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
import { cleanupTenant, createTenantFixture, disconnectFixtureConnection, TenantFixture } from './tenant-fixture';
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

/** Only create() ever fails - findByConversation/deleteForTenant still hit the real database, exactly like chat-limits.integration-spec.ts's own FailingCreateAgentRunRepository. */
class FailingCreateAgentRunRepository implements AgentRunRepository {
  constructor(private readonly real: AgentRunRepository) {}
  create(_run: NewAgentRun, _session?: unknown): Promise<AgentRunRecord> {
    return Promise.reject(new Error('simulated AgentRun persistence failure'));
  }
  findByConversation(tenantId: string, conversationId: string): Promise<AgentRunRecord[]> {
    return this.real.findByConversation(tenantId, conversationId);
  }
  deleteForTenant(tenantId: string): Promise<void> {
    return this.real.deleteForTenant(tenantId);
  }
}

/** The mirror case - only create() ever fails, everything else (including the methods the verifier/decision flow needs) delegates to the real repository. */
class FailingCreateApprovalRepository implements ApprovalRepository {
  constructor(private readonly real: ApprovalRepository) {}
  create(_input: NewApproval, _session?: unknown): Promise<ApprovalRecord> {
    return Promise.reject(new Error('simulated Approval persistence failure'));
  }
  findById(tenantId: string, id: string): Promise<ApprovalRecord | null> {
    return this.real.findById(tenantId, id);
  }
  findActiveByOrder(tenantId: string, orderId: string): Promise<ApprovalRecord | null> {
    return this.real.findActiveByOrder(tenantId, orderId);
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
  markExecuted(...args: Parameters<ApprovalRepository['markExecuted']>): ReturnType<ApprovalRepository['markExecuted']> {
    return this.real.markExecuted(...args);
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

interface Harness {
  app: INestApplication;
  scriptableLlm: ScriptableLlmProvider;
  mockStore: MockStoreHandle;
  tempConnectorRoot: string;
  close: () => Promise<void>;
}

async function bootHarness(overrideApprovalRepo: boolean): Promise<Harness> {
  const mockStore = await startMockStore();
  const tempConnectorRoot = await makeTempConnectorRoot();
  process.env.NODE_ENV = 'test';
  process.env.ALLOW_PRIVATE_NETWORKS = 'true';
  process.env.CONNECTOR_HOST_ALLOWLIST = `127.0.0.1:${new URL(mockStore.baseUrl).port}`;
  process.env.CONNECTOR_CONFIG_DIR = tempConnectorRoot;
  process.env[CONNECTOR_SECRET_ENV_VAR] = MOCK_STORE_TOKEN;

  const scriptableLlm = new ScriptableLlmProvider();
  let builder = Test.createTestingModule({ imports: [AppModule] }).overrideProvider(LLM_PROVIDER).useValue(scriptableLlm);

  if (overrideApprovalRepo) {
    builder = builder.overrideProvider(APPROVAL_REPOSITORY).useFactory({
      inject: [getModelToken('Approval')],
      factory: (model: Model<ApprovalDocument>) => new FailingCreateApprovalRepository(new MongooseApprovalRepository(model)),
    });
  } else {
    builder = builder.overrideProvider(AGENT_RUN_REPOSITORY).useFactory({
      inject: [getModelToken('AgentRun')],
      factory: (model: Model<AgentRunDocument>) => new FailingCreateAgentRunRepository(new MongooseAgentRunRepository(model)),
    });
  }

  const moduleRef = await builder.compile();
  const app = moduleRef.createNestApplication();
  await app.init();

  return {
    app,
    scriptableLlm,
    mockStore,
    tempConnectorRoot,
    close: async () => {
      await app.close();
      delete process.env.ALLOW_PRIVATE_NETWORKS;
      delete process.env.CONNECTOR_HOST_ALLOWLIST;
      delete process.env.CONNECTOR_CONFIG_DIR;
      delete process.env[CONNECTOR_SECRET_ENV_VAR];
      await mockStore.close();
      await removeTempConnectorRoot(tempConnectorRoot);
    },
  };
}

async function newTenantFor(h: Harness): Promise<TenantFixture> {
  const tenant = await createTenantFixture(uri);
  await writeAcmeConnectorFixtures(h.tempConnectorRoot, tenant.tenantId, h.mockStore.baseUrl);
  return tenant;
}

/** A genuine, verifier-passing proposal: a real delivered order (ORD-1001), a real cited policy chunk, an amount within the remaining refundable total - this MUST reach the transactional pending_approval path, never the standalone 'denied' path, or the test would prove nothing about the transaction itself. */
async function proposeAndSend(h: Harness, tenant: TenantFixture, token: string): Promise<request.Response> {
  const uniqueWord = `dualwritelexeme${Date.now()}${Math.random().toString(36).slice(2)}`;
  const uploadRes = await request(h.app.getHttpServer())
    .post('/v1/policies')
    .set('Authorization', `Bearer ${tenant.secretKey}`)
    .attach('file', Buffer.from(`# Policy\n\nA delivered order that arrived damaged can be refunded. ${uniqueWord}.`), 'policy.md')
    .field('title', 'Policy');
  const documentId = uploadRes.body.id as string;
  const retrievalService = h.app.get(PolicyRetrievalService);
  const found = await pollUntil(async () => {
    const r = await retrievalService.retrieve(tenant.tenantId, uniqueWord);
    return r.ok && r.results.some((x) => x.documentId === documentId) ? r.results.find((x) => x.documentId === documentId) : undefined;
  }, `tenant ${tenant.tenantId}'s policy chunk becoming searchable for "${uniqueWord}"`);
  const chunkKey = found!.chunkKey;

  h.scriptableLlm.setScript([
    planOutput({ needsPolicy: true, searchQuery: uniqueWord, toolRequests: [{ tool: 'get_order', order_id: 'ORD-1001' }] }),
    composeOutput({ outcome: 'propose_refund', message: 'Refunding you.', citedChunkKeys: [chunkKey], proposedRefund: { order_id: 'ORD-1001', amount: 10 } }),
  ]);

  return request(h.app.getHttpServer())
    .post('/v1/chat')
    .set('Authorization', `Bearer ${tenant.publicKey}`)
    .send({ message: 'my order arrived damaged, refund me', customerToken: token });
}

describe.skipIf(!integrationTestsEnabled())('Dual-write transaction failure: AgentRun create() fails (integration, real database)', () => {
  let h: Harness;
  const createdTenants: string[] = [];

  beforeAll(async () => {
    h = await bootHarness(false);
  }, 150_000);
  afterAll(async () => {
    await Promise.all(createdTenants.map((tenantId) => cleanupTenant(uri, tenantId)));
    await h.close();
    await disconnectFixtureConnection();
  });

  it('neither the Approval nor the AgentRun exists afterward; the customer gets the generic 503; no proposal reaches them', async () => {
    const tenant = await newTenantFor(h);
    createdTenants.push(tenant.tenantId);
    const { kid, privateKey } = await registerCustomerKeyFixture(uri, tenant.tenantId);
    const token = mintCustomerToken(tenant.tenantId, 'cust_1', kid, privateKey);

    const res = await proposeAndSend(h, tenant, token);

    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({ code: 'PENDING_APPROVAL_WRITE_FAILED' });
    expect(res.body).not.toHaveProperty('proposedAction');

    const approvalRepo = h.app.get<ApprovalRepository>(APPROVAL_REPOSITORY);
    expect((await approvalRepo.list(tenant.tenantId, {})).approvals).toHaveLength(0);

    // findByConversation still hits the REAL database (only create() is wrapped) - this proves
    // no AgentRun document was left behind either, not just that the HTTP response looked right.
    const realAgentRunRepo = new MongooseAgentRunRepository(h.app.get(getModelToken('AgentRun')));
    const conversationModel = h.app.get<Model<unknown>>(getModelToken('Conversation'));
    const conversationDoc = await conversationModel.collection.findOne({ tenantId: tenant.tenantId });
    const conversationId = (conversationDoc as unknown as { _id: string })._id;
    expect(await realAgentRunRepo.findByConversation(tenant.tenantId, conversationId)).toHaveLength(0);
  });
});

describe.skipIf(!integrationTestsEnabled())('Dual-write transaction failure: Approval create() fails (integration, real database) - mirror case', () => {
  let h: Harness;
  const createdTenants: string[] = [];

  beforeAll(async () => {
    h = await bootHarness(true);
  }, 150_000);
  afterAll(async () => {
    await Promise.all(createdTenants.map((tenantId) => cleanupTenant(uri, tenantId)));
    await h.close();
    await disconnectFixtureConnection();
  });

  it('neither the Approval nor the AgentRun exists afterward; the customer gets the generic 503; no proposal reaches them', async () => {
    const tenant = await newTenantFor(h);
    createdTenants.push(tenant.tenantId);
    const { kid, privateKey } = await registerCustomerKeyFixture(uri, tenant.tenantId);
    const token = mintCustomerToken(tenant.tenantId, 'cust_1', kid, privateKey);

    const res = await proposeAndSend(h, tenant, token);

    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({ code: 'PENDING_APPROVAL_WRITE_FAILED' });
    expect(res.body).not.toHaveProperty('proposedAction');

    // findActiveByOrder and list both still hit the REAL database (only create() is wrapped).
    const realApprovalRepo = new MongooseApprovalRepository(h.app.get(getModelToken('Approval')));
    expect((await realApprovalRepo.list(tenant.tenantId, {})).approvals).toHaveLength(0);
    expect(await realApprovalRepo.findActiveByOrder(tenant.tenantId, 'ORD-1001')).toBeNull();

    const realAgentRunRepo = new MongooseAgentRunRepository(h.app.get(getModelToken('AgentRun')));
    const conversationModel = h.app.get<Model<unknown>>(getModelToken('Conversation'));
    const conversationDoc = await conversationModel.collection.findOne({ tenantId: tenant.tenantId });
    const conversationId = (conversationDoc as unknown as { _id: string })._id;
    expect(await realAgentRunRepo.findByConversation(tenant.tenantId, conversationId)).toHaveLength(0);
  });
});
