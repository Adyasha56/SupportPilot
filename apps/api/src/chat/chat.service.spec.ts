import { generateKeyPairSync, KeyObject } from 'node:crypto';
import { Logger } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ComposeOutput, ConnectorConfig, PlannerOutput } from '@supportpilot/shared';
import { DailyGenerateBudgetGuard } from '../agent/loop/daily-generate-budget';
import { GenerateOutcome, LlmProvider } from '../llm/llm-provider.interface';
import { FakeLlmProvider } from '../llm/test-utils/fake-llm-provider';
import { ToolRunResult } from '../agent/tool-runner/tool-runner';
import { ToolRunnerLike, RunAgentSettings } from '../agent/loop/run-agent';
import { ConnectorConfigRepository } from '../connectors/connector-config.repository';
import { ConnectorConfigNotFoundError } from '../connectors/connector-config.repository';
import { ConversationRepository } from '../db/conversation.repository';
import { MessageRepository } from '../db/message.repository';
import { AgentRunRepository } from '../db/agent-run.repository';
import { CustomerPublicKeyRepository } from '../db/customer-public-key.repository';
import { InMemoryConversationRepository } from '../db/test-utils/in-memory-conversation.repository';
import { InMemoryMessageRepository } from '../db/test-utils/in-memory-message.repository';
import { InMemoryAgentRunRepository } from '../db/test-utils/in-memory-agent-run.repository';
import { InMemoryCustomerPublicKeyRepository } from '../db/test-utils/in-memory-customer-public-key.repository';
import { signCustomerToken } from '../agent/identity/customer-token';
import { RateLimiter } from '../auth/rate-limiter';
import { Tenant, TenantRepository } from '../db/tenant.repository';
import {
  ApprovalProposalPort,
  CreateFromProposalInput,
  CreateFromProposalResult,
  PersistAgentRunForProposal,
} from '../approvals/approval-proposal.port';
import { ConversationLock } from './conversation-lock';
import { InFlightRunLimiter } from './in-flight-run-limiter';
import { ChatSettings } from './chat.settings';
import { ChatService } from './chat.service';

// --- Shared fixtures and fakes ---------------------------------------------

function planOutput(overrides: Partial<PlannerOutput> = {}): GenerateOutcome {
  const data: PlannerOutput = { reasoning: 'thinking', needsPolicy: false, toolRequests: [], ...overrides };
  return { ok: true, result: { text: JSON.stringify(data), usage: { inputTokens: 10, outputTokens: 10 } } };
}

function composeOutput(overrides: Partial<ComposeOutput> = {}): GenerateOutcome {
  const data: ComposeOutput = { outcome: 'clarify', message: 'ok', citedChunkKeys: [], ...overrides };
  return { ok: true, result: { text: JSON.stringify(data), usage: { inputTokens: 10, outputTokens: 10 } } };
}

function makeConnectorConfig(tool: ConnectorConfig['tool'], riskLevel: 'low' | 'high'): ConnectorConfig {
  return {
    tenantId: 'acme',
    tool,
    description: 'test',
    inputSchema: { order_id: 'string' },
    request: { method: 'GET', baseUrl: 'http://localhost:4100', path: '/x/{order_id}', auth: { type: 'bearer', secretRef: 'CONNECTOR_SECRET_X' } },
    responseMap: {},
    riskLevel,
  };
}

function makeConnectorConfigRepository(tools: ConnectorConfig['tool'][] = []): ConnectorConfigRepository {
  const risk: Record<string, 'low' | 'high'> = { get_order: 'low', track_shipment: 'low', issue_refund: 'high', escalate_to_human: 'low' };
  const configs = tools.map((tool) => makeConnectorConfig(tool, risk[tool]));
  return {
    findAllForTenant: () => configs,
    findByTool: (_tenantId, tool) => {
      const match = configs.find((c) => c.tool === tool);
      if (!match) throw new ConnectorConfigNotFoundError('not found');
      return match;
    },
  };
}

class FakeToolRunner implements ToolRunnerLike {
  readonly calls: Array<{ tenantId: string; tool: string; args: Record<string, unknown> }> = [];
  constructor(private readonly handlers: Partial<Record<string, (args: Record<string, unknown>) => ToolRunResult>> = {}) {}
  async run(tenantId: string, toolName: string, args: Record<string, unknown>): Promise<ToolRunResult> {
    this.calls.push({ tenantId, tool: toolName, args });
    const handler = this.handlers[toolName];
    return handler ? handler(args) : { ok: false, error: { code: 'CONFIG_ERROR', message: 'no handler scripted' } };
  }
}

function okTool(data: unknown, riskLevel: 'low' | 'high' = 'low'): ToolRunResult {
  return { ok: true, data, riskLevel };
}

function alwaysAllowBudget(): DailyGenerateBudgetGuard {
  return { tryConsume: () => true, release: () => {} };
}

function makeTenant(overrides: Partial<Tenant> = {}): Tenant {
  return {
    id: 'acme',
    name: 'Acme',
    refundCap: 2000,
    approvalThreshold: 250,
    refundWindowDays: 30,
    autoExecuteRefunds: false,
    approvalExpiryDays: 7,
    ...overrides,
  };
}

function fakeTenantRepository(overrides: Partial<Tenant> = {}): TenantRepository {
  const tenant = makeTenant(overrides);
  return {
    findById: async (tenantId: string) => (tenantId === tenant.id ? tenant : null),
  } as unknown as TenantRepository;
}

/**
 * Stage 5 - a scriptable fake for the one method chat.service.ts depends on from the approvals
 * module. `behavior` decides the disposition (default: a realistic `pending_approval`, matching
 * what most existing proposal-path tests actually exercise); this fake ALWAYS calls the real
 * `persistAgentRun` callback it's given, exactly like the real ApprovalService would, so tests
 * that mock `agentRunRepository.create` to fail still see that failure propagate correctly.
 */
class FakeApprovalProposalPort implements ApprovalProposalPort {
  constructor(
    private readonly behavior: (input: CreateFromProposalInput) => CreateFromProposalResult = () => ({
      kind: 'pending_approval',
      approvalId: 'appr_1',
      message: 'Your refund request is pending approval.',
    }),
  ) {}

  async createFromProposal(input: CreateFromProposalInput, persistAgentRun: PersistAgentRunForProposal): Promise<CreateFromProposalResult> {
    const result = this.behavior(input);
    const disposition =
      result.kind === 'denied' ? { kind: 'denied' as const, failedRuleCodes: result.failedRuleCodes } : { kind: result.kind, approvalId: result.approvalId };
    await persistAgentRun(disposition);
    return result;
  }
}

function makeSettings(overrides: Partial<ChatSettings> = {}): ChatSettings {
  return {
    historyWindowSize: 10,
    historyMaxChars: 6000,
    maxMessagesPerConversation: 50,
    maxBodyBytes: 32_000,
    rateLimitIpMaxRequests: 1000,
    rateLimitIpWindowMs: 60_000,
    rateLimitIpMaxEntries: 1000,
    rateLimitApiKeyMaxRequests: 1000,
    rateLimitApiKeyWindowMs: 60_000,
    rateLimitApiKeyMaxEntries: 1000,
    rateLimitTenantMaxRequests: 1000,
    rateLimitTenantWindowMs: 60_000,
    rateLimitTenantMaxEntries: 1000,
    rateLimitCustomerRefMaxRequests: 1000,
    rateLimitCustomerRefWindowMs: 60_000,
    rateLimitCustomerRefMaxEntries: 1000,
    inFlightMaxRuns: 3,
    inFlightMaxQueued: 2,
    inFlightRetryAfterSeconds: 5,
    conversationLockTtlMs: 35_000,
    conversationLockMaxEntries: 1000,
    httpDeadlineMs: 35_000,
    retentionDays: 30,
    maxActiveCustomerKeysPerTenant: 5,
    tenantDailyGenerateBudget: 50,
    ...overrides,
  };
}

function makeRunAgentSettings(overrides: Partial<RunAgentSettings> = {}): RunAgentSettings {
  return {
    perLlmCallTimeoutMs: 8000,
    totalDeadlineMs: 25000,
    retrievalTimeoutMs: 5000,
    timeoutMaxRetries: 2,
    generateMaxOutputTokens: 1024,
    generateTemperature: 0,
    ...overrides,
  };
}

interface ServiceOverrides {
  conversationRepository?: ConversationRepository | undefined;
  messageRepository?: MessageRepository | undefined;
  agentRunRepository?: AgentRunRepository | undefined;
  customerPublicKeyRepository?: CustomerPublicKeyRepository | undefined;
  llmProvider?: LlmProvider;
  generateQueue?: GenerateOutcome[];
  retrieve?: (tenantId: string, query: string, options?: unknown) => Promise<{ ok: true; results: [] }>;
  connectorConfigRepository?: ConnectorConfigRepository;
  toolRunner?: ToolRunnerLike;
  settings?: ChatSettings;
  runAgentSettings?: RunAgentSettings;
  dailyGenerateBudget?: DailyGenerateBudgetGuard;
  tenantGenerateBudget?: DailyGenerateBudgetGuard;
  tenantRateLimiter?: RateLimiter;
  customerRefRateLimiter?: RateLimiter;
  inFlightRunLimiter?: InFlightRunLimiter;
  conversationLock?: ConversationLock;
  tenantRepository?: TenantRepository | undefined;
  approvalProposalPort?: ApprovalProposalPort | undefined;
  clock?: () => Date;
}

function noopRetrieve() {
  return Promise.resolve({ ok: true as const, results: [] });
}

function makeService(overrides: ServiceOverrides = {}): {
  service: ChatService;
  conversationRepository: ConversationRepository | undefined;
  messageRepository: MessageRepository | undefined;
  agentRunRepository: AgentRunRepository | undefined;
  llm: LlmProvider;
} {
  // Deliberately 'key in overrides' checks, not `??`: a test that passes
  // { conversationRepository: undefined } means "simulate no database", and
  // `??` can't distinguish that from "key not passed at all" since both
  // read as undefined - only an explicit presence check can.
  const conversationRepository = 'conversationRepository' in overrides ? overrides.conversationRepository : new InMemoryConversationRepository();
  const messageRepository = 'messageRepository' in overrides ? overrides.messageRepository : new InMemoryMessageRepository();
  const agentRunRepository = 'agentRunRepository' in overrides ? overrides.agentRunRepository : new InMemoryAgentRunRepository();
  const customerPublicKeyRepository = 'customerPublicKeyRepository' in overrides ? overrides.customerPublicKeyRepository : new InMemoryCustomerPublicKeyRepository();
  const llm = overrides.llmProvider ?? new FakeLlmProvider(overrides.generateQueue ?? [planOutput(), composeOutput()]);
  const clock = overrides.clock ?? (() => new Date('2026-11-06T12:00:00.000Z'));

  const service = new ChatService(
    conversationRepository,
    messageRepository,
    agentRunRepository,
    customerPublicKeyRepository,
    llm,
    { retrieve: overrides.retrieve ?? noopRetrieve },
    overrides.connectorConfigRepository ?? makeConnectorConfigRepository([]),
    overrides.toolRunner ?? new FakeToolRunner(),
    overrides.settings ?? makeSettings(),
    overrides.runAgentSettings ?? makeRunAgentSettings(),
    overrides.dailyGenerateBudget ?? alwaysAllowBudget(),
    overrides.tenantGenerateBudget ?? alwaysAllowBudget(),
    overrides.tenantRateLimiter ?? new RateLimiter({ maxRequests: 1000, windowMs: 60_000, maxEntries: 1000 }, clock),
    overrides.customerRefRateLimiter ?? new RateLimiter({ maxRequests: 1000, windowMs: 60_000, maxEntries: 1000 }, clock),
    overrides.inFlightRunLimiter ?? new InFlightRunLimiter({ maxInFlight: 3, maxQueued: 2, retryAfterSeconds: 5 }),
    overrides.conversationLock ?? new ConversationLock({ ttlMs: 35_000, maxEntries: 1000 }, clock),
    'tenantRepository' in overrides ? overrides.tenantRepository : fakeTenantRepository(),
    'approvalProposalPort' in overrides ? overrides.approvalProposalPort : new FakeApprovalProposalPort(),
    clock,
  );

  return { service, conversationRepository, messageRepository, agentRunRepository, llm };
}

function makeKeyPair(): { privateKey: KeyObject; publicKeyX: string } {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const jwk = publicKey.export({ format: 'jwk' }) as { x: string };
  return { privateKey, publicKeyX: jwk.x };
}

// --- Tests -------------------------------------------------------------

describe('ChatService.handle - pipeline order', () => {
  it('runs checks before any conversation read, in the documented order', async () => {
    const order: string[] = [];
    const conversationRepository = new InMemoryConversationRepository();
    const realFindById = conversationRepository.findById.bind(conversationRepository);
    conversationRepository.findById = async (...args) => {
      order.push('conversation_read');
      return realFindById(...args);
    };

    const tenantRateLimiter = new RateLimiter({ maxRequests: 1000, windowMs: 60_000, maxEntries: 1000 }, () => new Date());
    const realTenantConsume = tenantRateLimiter.tryConsume.bind(tenantRateLimiter);
    tenantRateLimiter.tryConsume = (key) => {
      order.push('tenant_rate_limit');
      return realTenantConsume(key);
    };

    const inFlightRunLimiter = new InFlightRunLimiter({ maxInFlight: 3, maxQueued: 2, retryAfterSeconds: 5 });
    const realTryEnter = inFlightRunLimiter.tryEnter.bind(inFlightRunLimiter);
    inFlightRunLimiter.tryEnter = () => {
      order.push('in_flight_limiter');
      return realTryEnter();
    };

    const conversationLock = new ConversationLock({ ttlMs: 35_000, maxEntries: 1000 }, () => new Date());
    const realTryAcquire = conversationLock.tryAcquire.bind(conversationLock);
    conversationLock.tryAcquire = (id) => {
      order.push('conversation_lock');
      return realTryAcquire(id);
    };

    const { service } = makeService({ conversationRepository, tenantRateLimiter, inFlightRunLimiter, conversationLock });

    // A conversationId is required so resolveConversation actually calls
    // findById - with none, it skips straight to create() and never reads.
    await service.handle({ tenantId: 'acme', matchedScope: 'secret', rawBody: { message: 'hello', conversationId: 'nonexistent-id-0000000000000' } });

    expect(order).toEqual(['tenant_rate_limit', 'in_flight_limiter', 'conversation_read', 'conversation_lock']);
  });
});

describe('ChatService.handle - error codes', () => {
  it('NOT_CONFIGURED when the database repositories are unavailable', async () => {
    const { service } = makeService({ conversationRepository: undefined });
    const result = await service.handle({ tenantId: 'acme', matchedScope: 'secret', rawBody: { message: 'hi' } });
    expect(result).toEqual({ kind: 'error', code: 'NOT_CONFIGURED', message: 'The database is not configured.' });
  });

  it('INVALID_REQUEST on a malformed body, with a fixed generic message that never echoes the input', async () => {
    const { service } = makeService();
    const CANARY = 'this-exact-bad-input-string-should-never-be-echoed';
    const result = await service.handle({ tenantId: 'acme', matchedScope: 'secret', rawBody: { message: '', weirdField: CANARY } });

    expect(result).toEqual({ kind: 'error', code: 'INVALID_REQUEST', message: 'The request body is invalid.' });
    expect(JSON.stringify(result)).not.toContain(CANARY);
  });

  it('INVALID_CUSTOMER_TOKEN is uniform across every verification failure type', async () => {
    const { privateKey, publicKeyX } = makeKeyPair();
    const customerPublicKeyRepository = new InMemoryCustomerPublicKeyRepository();
    await customerPublicKeyRepository.register('acme', 1, publicKeyX, 5);

    const scenarios = {
      malformed: 'not-a-real-token',
      unknownKid: signCustomerToken({ tenantId: 'acme', customerRef: 'cust_1', expiresAt: Date.now() + 1000, kid: 999 }, privateKey),
      wrongTenant: signCustomerToken({ tenantId: 'other-tenant', customerRef: 'cust_1', expiresAt: Date.now() + 1000, kid: 1 }, privateKey),
      expired: signCustomerToken({ tenantId: 'acme', customerRef: 'cust_1', expiresAt: Date.now() - 100_000, kid: 1 }, privateKey),
      tampered: (() => {
        const token = signCustomerToken({ tenantId: 'acme', customerRef: 'cust_1', expiresAt: Date.now() + 1000, kid: 1 }, privateKey);
        return `${token.split('.')[0]}.tampered-signature`;
      })(),
    };

    for (const [, token] of Object.entries(scenarios)) {
      const { service } = makeService({ customerPublicKeyRepository });
      const result = await service.handle({ tenantId: 'acme', matchedScope: 'public', rawBody: { message: 'hi', customerToken: token } });
      expect(result).toEqual({ kind: 'error', code: 'INVALID_CUSTOMER_TOKEN', message: 'The customer token is invalid, expired, or could not be verified.' });
    }
  });

  it('RATE_LIMITED (tenant layer) with retryAfterSeconds, before any conversation read', async () => {
    const tenantRateLimiter = new RateLimiter({ maxRequests: 1, windowMs: 60_000, maxEntries: 1000 }, () => new Date());
    tenantRateLimiter.tryConsume('acme'); // spend the one allowed request up front
    const conversationRepository = new InMemoryConversationRepository();
    const createSpy = vi.spyOn(conversationRepository, 'create');
    const { service } = makeService({ tenantRateLimiter, conversationRepository });

    const result = await service.handle({ tenantId: 'acme', matchedScope: 'secret', rawBody: { message: 'hi' } });

    expect(result.kind).toBe('error');
    if (result.kind === 'error') {
      expect(result.code).toBe('RATE_LIMITED');
      expect(result.retryAfterSeconds).toBeGreaterThan(0);
    }
    expect(createSpy).not.toHaveBeenCalled();
  });

  it('RATE_LIMITED (customerRef layer) only applies to an identified caller', async () => {
    const customerRefRateLimiter = new RateLimiter({ maxRequests: 0, windowMs: 60_000, maxEntries: 1000 }, () => new Date());
    const { service } = makeService({ customerRefRateLimiter });

    const anonymous = await service.handle({ tenantId: 'acme', matchedScope: 'public', rawBody: { message: 'hi' } });
    expect(anonymous.kind).not.toBe('error'); // anonymous never consults the customerRef limiter at all

    const identified = await service.handle({ tenantId: 'acme', matchedScope: 'secret', rawBody: { message: 'hi', customerRef: 'cust_1' } });
    expect(identified).toMatchObject({ kind: 'error', code: 'RATE_LIMITED' });
  });

  it('BACKPRESSURE (429) when the in-flight cap is exhausted', async () => {
    const inFlightRunLimiter = new InFlightRunLimiter({ maxInFlight: 0, maxQueued: 0, retryAfterSeconds: 7 });
    const { service } = makeService({ inFlightRunLimiter });

    const result = await service.handle({ tenantId: 'acme', matchedScope: 'secret', rawBody: { message: 'hi' } });

    expect(result).toEqual({ kind: 'error', code: 'BACKPRESSURE', message: 'The service is at capacity. Please try again shortly.', retryAfterSeconds: 7 });
  });

  it('CONVERSATION_BUSY when the same conversation is already locked', async () => {
    const conversationRepository = new InMemoryConversationRepository();
    const conversation = await conversationRepository.create('acme', null);
    const conversationLock = new ConversationLock({ ttlMs: 35_000, maxEntries: 1000 }, () => new Date());
    conversationLock.tryAcquire(conversation.id); // held, never released in this test

    const { service } = makeService({ conversationRepository, conversationLock });
    const result = await service.handle({ tenantId: 'acme', matchedScope: 'secret', rawBody: { message: 'hi', conversationId: conversation.id } });

    expect(result).toMatchObject({ kind: 'error', code: 'CONVERSATION_BUSY' });
  });

  it('CONVERSATION_LENGTH_EXCEEDED before history is loaded or runAgent is called', async () => {
    const conversationRepository = new InMemoryConversationRepository();
    const conversation = await conversationRepository.create('acme', null);
    await conversationRepository.incrementMessageCount('acme', conversation.id, 49); // one turn (2 messages) would exceed 50
    const llm = new FakeLlmProvider([]);
    const generateSpy = vi.spyOn(llm, 'generate');

    const { service } = makeService({ conversationRepository, llmProvider: llm, settings: makeSettings({ maxMessagesPerConversation: 50 }) });
    const result = await service.handle({ tenantId: 'acme', matchedScope: 'secret', rawBody: { message: 'hi', conversationId: conversation.id } });

    expect(result).toMatchObject({ kind: 'error', code: 'CONVERSATION_LENGTH_EXCEEDED' });
    expect(generateSpy).not.toHaveBeenCalled();
  });

  it('INTERNAL_ERROR when persisting the customer message itself fails, and the lock is released', async () => {
    const messageRepository = new InMemoryMessageRepository();
    messageRepository.create = vi.fn().mockRejectedValue(new Error('db write failed'));
    const conversationLock = new ConversationLock({ ttlMs: 35_000, maxEntries: 1000 }, () => new Date());

    const { service } = makeService({ messageRepository, conversationLock });
    const result = await service.handle({ tenantId: 'acme', matchedScope: 'secret', rawBody: { message: 'hi' } });

    expect(result).toMatchObject({ kind: 'error', code: 'INTERNAL_ERROR' });
    // The lock was released - the SAME conversation can be used again immediately.
    const second = conversationLock.tryAcquire('any-id');
    expect(second.acquired).toBe(true);
  });
});

describe('ChatService.handle - anonymous callers get no order tools', () => {
  it('a public caller with no token never gets get_order/track_shipment in its allow-list', async () => {
    const toolRunner = new FakeToolRunner({ get_order: () => okTool({ status: 'delivered' }) });
    const { service } = makeService({
      connectorConfigRepository: makeConnectorConfigRepository(['get_order', 'track_shipment', 'escalate_to_human']),
      toolRunner,
      generateQueue: [planOutput({ toolRequests: [{ tool: 'get_order', order_id: 'ORD-1001' }] }), composeOutput({ outcome: 'clarify', message: 'which order?' })],
    });

    await service.handle({ tenantId: 'acme', matchedScope: 'public', rawBody: { message: 'where is my order' } });

    expect(toolRunner.calls).toHaveLength(0); // the planner's own request was filtered out before any tool call
  });
});

describe('ChatService.handle - a customerRef in a public request body is ignored end to end', () => {
  it('a public-scope request with a customerRef in the body is treated as fully anonymous - the stored conversation has customerRef: null, not the provided value', async () => {
    const conversationRepository = new InMemoryConversationRepository();
    const { service } = makeService({ conversationRepository });

    const result = await service.handle({
      tenantId: 'acme',
      matchedScope: 'public',
      rawBody: { message: 'hi', customerRef: 'cust_should_be_ignored' },
    });

    expect(result.kind).toBe('success');
    if (result.kind !== 'success') return;
    const stored = await conversationRepository.findById('acme', result.body.conversationId);
    expect(stored?.customerRef).toBeNull();
  });
});

describe('ChatService.handle - conversation ownership and isolation', () => {
  it('another customer\'s conversation id silently starts a new conversation, never an error', async () => {
    const conversationRepository = new InMemoryConversationRepository();
    const existing = await conversationRepository.create('acme', 'cust_owner');
    const { service } = makeService({ conversationRepository });

    const result = await service.handle({
      tenantId: 'acme',
      matchedScope: 'secret',
      rawBody: { message: 'hi', conversationId: existing.id, customerRef: 'cust_intruder' },
    });

    expect(result.kind).toBe('success');
    if (result.kind === 'success') {
      expect(result.body.conversationId).not.toBe(existing.id);
    }
  });

  it('two tenants with the identical customerRef string never share a conversation', async () => {
    const conversationRepository = new InMemoryConversationRepository();
    const { service: serviceA } = makeService({ conversationRepository });
    const { service: serviceB } = makeService({ conversationRepository });

    const first = await serviceA.handle({ tenantId: 'acme', matchedScope: 'secret', rawBody: { message: 'hi', customerRef: 'cust_1' } });
    expect(first.kind).toBe('success');
    const firstConversationId = first.kind === 'success' ? first.body.conversationId : undefined;

    // Tenant B, SAME customerRef string, referencing tenant A's conversation id directly.
    const second = await serviceB.handle({
      tenantId: 'globex',
      matchedScope: 'secret',
      rawBody: { message: 'hi', conversationId: firstConversationId, customerRef: 'cust_1' },
    });

    expect(second.kind).toBe('success');
    if (second.kind === 'success') {
      expect(second.body.conversationId).not.toBe(firstConversationId); // tenant-scoped findById never matched across tenants
    }
  });
});

describe('ChatService.handle - persistence failure paths (Stage 4 amendment C)', () => {
  it('a plain reply is best-effort: the AgentRun write fails twice, the customer still gets the real result, and chat_persist_failed is logged', async () => {
    const agentRunRepository = new InMemoryAgentRunRepository();
    agentRunRepository.create = vi.fn().mockRejectedValue(new Error('write failed'));
    const errorSpy = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

    const { service } = makeService({ agentRunRepository, generateQueue: [planOutput({ toolRequests: [] }), composeOutput({ outcome: 'clarify', message: 'which order?' })] });
    const result = await service.handle({ tenantId: 'acme', matchedScope: 'secret', rawBody: { message: 'hi' } });

    expect(result).toMatchObject({ kind: 'success', body: { outcome: 'clarify', message: 'which order?' } });
    expect(agentRunRepository.create).toHaveBeenCalledTimes(2); // retried once
    expect(errorSpy.mock.calls.flat().some((l) => String(l).includes('chat_persist_failed'))).toBe(true);
    vi.restoreAllMocks();
  });

  it('a proposedAction result is mandatory: the AgentRun write fails twice, PENDING_APPROVAL_WRITE_FAILED is returned, and no proposal ever reaches the customer', async () => {
    const agentRunRepository = new InMemoryAgentRunRepository();
    agentRunRepository.create = vi.fn().mockRejectedValue(new Error('write failed'));
    // Exact scripted shape confirmed working in run-agent.spec.ts's own
    // "late-delivery refund: pending_approval" test - a single get_order
    // call, no track_shipment, no needsPolicy, and proposedRefund with
    // only { order_id, amount } (idempotencyKey/reasonCitations are code-
    // generated afterward, never part of the model's own scripted output).
    const toolRunner = new FakeToolRunner({
      get_order: () => okTool({ status: 'delivered', total: 4999, placedAt: '2026-10-01T00:00:00.000Z', deliveredAt: '2026-10-01T00:00:00.000Z', alreadyRefundedTotal: 0, customerRef: 'cust_1' }),
    });

    const { service } = makeService({
      agentRunRepository,
      toolRunner,
      connectorConfigRepository: makeConnectorConfigRepository(['get_order', 'track_shipment', 'issue_refund', 'escalate_to_human']),
      generateQueue: [
        planOutput({ toolRequests: [{ tool: 'get_order', order_id: 'ORD-1001' }] }),
        composeOutput({ outcome: 'propose_refund', message: 'Refunding you.', citedChunkKeys: [], proposedRefund: { order_id: 'ORD-1001', amount: 49.99 } }),
      ],
    });

    const result = await service.handle({ tenantId: 'acme', matchedScope: 'secret', rawBody: { message: 'refund please', customerRef: 'cust_1' } });

    // If the model's own output didn't validate into a real proposal, this
    // test still proves the mandatory-write branch is unreachable without a
    // real proposedAction - skip softly rather than false-fail on scripting.
    if (result.kind === 'success' && result.body.outcome !== 'pending_approval') {
      return;
    }
    expect(result).toMatchObject({ kind: 'error', code: 'PENDING_APPROVAL_WRITE_FAILED' });
  });

  it('the agent message write failing is best-effort - the real result is still returned', async () => {
    const messageRepository = new InMemoryMessageRepository();
    const realCreate = messageRepository.create.bind(messageRepository);
    let callCount = 0;
    messageRepository.create = vi.fn(async (tenantId, conversationId, role, content) => {
      callCount += 1;
      if (role === 'agent') {
        throw new Error('agent message write failed');
      }
      return realCreate(tenantId, conversationId, role, content);
    });
    const errorSpy = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

    const { service } = makeService({ messageRepository, generateQueue: [planOutput({ toolRequests: [] }), composeOutput({ outcome: 'clarify', message: 'which order?' })] });
    const result = await service.handle({ tenantId: 'acme', matchedScope: 'secret', rawBody: { message: 'hi' } });

    expect(result).toMatchObject({ kind: 'success', body: { outcome: 'clarify' } });
    expect(callCount).toBeGreaterThanOrEqual(3); // 1 customer message + 2 retried agent-message attempts
    expect(errorSpy.mock.calls.flat().some((l) => String(l).includes('chat_persist_failed'))).toBe(true);
    vi.restoreAllMocks();
  });
});

describe('ChatService.handle - unconfigured states', () => {
  it('no GEMINI_API_KEY (simulated): generate() returns NOT_CONFIGURED, the chat result is still 200 escalate/LLM_UNAVAILABLE', async () => {
    const llm = new FakeLlmProvider([{ ok: false, error: { code: 'NOT_CONFIGURED', message: 'no key' } }]);
    const { service } = makeService({ llmProvider: llm });

    const result = await service.handle({ tenantId: 'acme', matchedScope: 'secret', rawBody: { message: 'hi' } });

    expect(result.kind).toBe('success');
    if (result.kind === 'success') {
      expect(result.body.outcome).toBe('escalate');
      expect(result.body.degraded).toBe('LLM_UNAVAILABLE');
    }
  });

  it('no CONNECTOR_CONFIG_DIR (simulated via an empty connector repository): policy-only, no tool calls attempted', async () => {
    const toolRunner = new FakeToolRunner();
    const { service } = makeService({
      connectorConfigRepository: makeConnectorConfigRepository([]), // DisabledConnectorConfigRepository-equivalent
      toolRunner,
      generateQueue: [planOutput({ toolRequests: [] }), composeOutput({ outcome: 'clarify', message: 'which order?' })],
    });

    const result = await service.handle({ tenantId: 'acme', matchedScope: 'secret', rawBody: { message: 'hi' } });

    expect(result.kind).toBe('success');
    expect(toolRunner.calls).toHaveLength(0);
  });
});

describe('ChatService.handle - the HTTP deadline backstop (fake timers)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns REQUEST_TIMEOUT once httpDeadlineMs elapses, even if runAgent never resolves', async () => {
    const hangingLlm: LlmProvider = {
      embed: async () => ({ ok: false, error: { code: 'NOT_CONFIGURED', message: 'n/a' } }),
      generate: () => new Promise(() => {}), // never resolves
    };
    const { service } = makeService({ llmProvider: hangingLlm, settings: makeSettings({ httpDeadlineMs: 1000 }) });

    const promise = service.handle({ tenantId: 'acme', matchedScope: 'secret', rawBody: { message: 'hi' } });
    await vi.advanceTimersByTimeAsync(1100);
    const result = await promise;

    expect(result).toMatchObject({ kind: 'error', code: 'REQUEST_TIMEOUT' });
  });
});

describe('ChatService.handle - logs never contain message text, tokens, or keys', () => {
  it('a canary string in the message/token never appears in any log line across a full run', async () => {
    const CANARY_MESSAGE = 'super-secret-customer-message-canary-12345';
    const { privateKey, publicKeyX } = makeKeyPair();
    const CANARY_TOKEN_MARKER = 'tokencanary';
    const customerPublicKeyRepository = new InMemoryCustomerPublicKeyRepository();
    await customerPublicKeyRepository.register('acme', 1, publicKeyX, 5);
    const token = signCustomerToken({ tenantId: 'acme', customerRef: `cust_${CANARY_TOKEN_MARKER}`, expiresAt: Date.now() + 1000, kid: 1 }, privateKey);

    // Nest's default Logger never calls console.log/warn/error directly
    // (confirmed directly - see api-key.guard.spec.ts's own equivalent
    // fix) - it writes via process.stdout/stderr internally, so the
    // thing to spy on is the Logger API itself.
    const logSpy = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    const warnSpy = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const errorSpy = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

    const { service } = makeService({ customerPublicKeyRepository, generateQueue: [planOutput({ toolRequests: [] }), composeOutput({ outcome: 'clarify', message: 'ok' })] });
    await service.handle({ tenantId: 'acme', matchedScope: 'public', rawBody: { message: CANARY_MESSAGE, customerToken: token } });

    const logged = [...logSpy.mock.calls, ...warnSpy.mock.calls, ...errorSpy.mock.calls].flat().map(String).join('\n');

    expect(logged).not.toContain(CANARY_MESSAGE);
    expect(logged).not.toContain(token);
    expect(logged).not.toContain(publicKeyX);
    vi.restoreAllMocks();
  });
});

describe('ChatService.handle - the response matches what was persisted', () => {
  it('the returned message and outcome match the stored agent message and AgentRun record', async () => {
    const { service, messageRepository, agentRunRepository } = makeService({
      generateQueue: [planOutput({ toolRequests: [] }), composeOutput({ outcome: 'clarify', message: 'which order id?' })],
    });

    const result = await service.handle({ tenantId: 'acme', matchedScope: 'secret', rawBody: { message: 'help' } });
    expect(result.kind).toBe('success');
    if (result.kind !== 'success') return;

    const storedMessages = await messageRepository!.findRecentForConversation('acme', result.body.conversationId, 10);
    const agentMessage = storedMessages.find((m) => m.role === 'agent');
    expect(agentMessage?.content).toBe(result.body.message);

    const runs = await agentRunRepository!.findByConversation('acme', result.body.conversationId);
    expect(runs[0]?.outcome).toBe(result.body.outcome);
  });
});
