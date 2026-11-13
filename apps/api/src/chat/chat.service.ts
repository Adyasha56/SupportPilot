import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { ChatRequest, ChatRequestSchema, ChatResult, ProposedAction, toCents } from '@supportpilot/shared';
import { ConnectorConfigRepository } from '../connectors/connector-config.repository';
import { CONNECTOR_CONFIG_REPOSITORY } from '../connectors/connector-config-repository.provider';
import {
  AgentStepTrace,
  AgentTrace,
  GENERIC_ESCALATE_MESSAGE,
  RunAgentDeps,
  RunAgentSettings,
  ToolRunnerLike,
  runAgent as runAgentFn,
} from '../agent/loop/run-agent';
import { DailyGenerateBudgetGuard } from '../agent/loop/daily-generate-budget';
import { LlmProvider } from '../llm/llm-provider.interface';
import { LLM_PROVIDER } from '../llm/llm.module';
import { PolicyRetrievalService } from '../retrieval/policy-retrieval.service';
import { AgentRunRepository, AGENT_RUN_REPOSITORY, NewAgentRun, NewAgentRunProposedAction, NewAgentRunRefundDisposition } from '../db/agent-run.repository';
import { ConversationRecord, ConversationRepository, CONVERSATION_REPOSITORY } from '../db/conversation.repository';
import { MessageRepository, MESSAGE_REPOSITORY } from '../db/message.repository';
import { CustomerPublicKeyRepository, CUSTOMER_PUBLIC_KEY_REPOSITORY } from '../db/customer-public-key.repository';
import { ApiKeyScope } from '../db/schemas/api-key.schema';
import { TenantRepository, TENANT_REPOSITORY } from '../db/tenant.repository';
import { RateLimiter } from '../auth/rate-limiter';
import {
  ApprovalProposalPort,
  APPROVAL_PROPOSAL_PORT,
  CreateFromProposalResult,
  PersistAgentRunForProposal,
  RefundDispositionForAgentRun,
} from '../approvals/approval-proposal.port';
import { ChatSettings } from './chat.settings';
import { CHAT_SETTINGS } from './chat-settings.provider';
import { RUN_AGENT_SETTINGS } from './run-agent-settings.provider';
import { DAILY_GENERATE_BUDGET, TENANT_GENERATE_BUDGET } from './budget-guards.provider';
import { READ_ONLY_TOOL_RUNNER } from './read-only-tool-runner.provider';
import { TENANT_RATE_LIMITER, CUSTOMER_REF_RATE_LIMITER } from './rate-limiters.provider';
import { CONVERSATION_LOCK } from './conversation-lock.provider';
import { IN_FLIGHT_RUN_LIMITER } from './in-flight-run-limiter.provider';
import { ConversationLock } from './conversation-lock';
import { InFlightRunLimiter } from './in-flight-run-limiter';
import { IdentityResolution, LookupPublicKey, resolveIdentity } from './identity-resolution';
import { peekUnverifiedKid } from './unverified-kid';
import { capHistoryByChars } from './history-window';
import { generateRunId } from './run-id';
import { ChatErrorCode } from './chat-http-error';

export type ChatHandleResult =
  | { kind: 'success'; body: ChatResult }
  | { kind: 'error'; code: ChatErrorCode; message: string; retryAfterSeconds?: number };

export interface ChatHandleInput {
  tenantId: string;
  /** The key's own highest capability (Stage 3's CurrentApiKeyScope), never just the route's declared requirement - this is what decides whether body.customerRef is honored. */
  matchedScope: ApiKeyScope;
  /** Unvalidated - ChatRequestSchema.safeParse happens inside handle(), first thing. */
  rawBody: unknown;
}

const GENERIC_INVALID_REQUEST_MESSAGE = 'The request body is invalid.';
const GENERIC_INTERNAL_ERROR_MESSAGE = "Something went wrong on our end. Please try again.";

function sumTokenUsage(steps: AgentStepTrace[]): { tokensIn: number; tokensOut: number } {
  let tokensIn = 0;
  let tokensOut = 0;
  for (const step of steps) {
    if (step.tokenUsage) {
      tokensIn += step.tokenUsage.inputTokens;
      tokensOut += step.tokenUsage.outputTokens;
    }
  }
  return { tokensIn, tokensOut };
}

/** The two mirrored shapes (ApprovalProposalPort's RefundDispositionForAgentRun and AgentRunRepository's own NewAgentRunRefundDisposition) are identical by design - see approval-proposal.port.ts's own doc comment for why they're two separate types rather than one shared import. */
function toNewAgentRunRefundDisposition(disposition: RefundDispositionForAgentRun): NewAgentRunRefundDisposition {
  return disposition;
}

function toNewAgentRunProposedAction(action: ProposedAction | undefined): NewAgentRunProposedAction | undefined {
  if (!action) {
    return undefined;
  }
  return { tool: action.tool, orderId: action.args.order_id, amount: action.args.amount };
}

async function withOneRetry<T>(fn: () => Promise<T>): Promise<{ ok: true; value: T } | { ok: false; error: unknown }> {
  try {
    return { ok: true, value: await fn() };
  } catch {
    try {
      return { ok: true, value: await fn() };
    } catch (secondError) {
      return { ok: false, error: secondError };
    }
  }
}

async function raceTimeout<T>(promise: Promise<T>, ms: number): Promise<{ timedOut: false; value: T } | { timedOut: true }> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<{ timedOut: true }>((resolve) => {
    timer = setTimeout(() => resolve({ timedOut: true }), ms);
  });
  try {
    return await Promise.race([promise.then((value) => ({ timedOut: false as const, value })), timeout]);
  } finally {
    clearTimeout(timer!);
  }
}

/**
 * ChatService.handle() returns a typed result (success | error) - it never
 * throws an HTTP exception itself and knows nothing about status codes;
 * chat.controller.ts is the ONLY place that maps this to a response, via
 * chat-http-error.ts. This keeps the entire pipeline below testable with
 * plain unit tests (new ChatService(fakes...), no Nest test module, no
 * database) and keeps the HTTP mapping in exactly one place.
 *
 * PIPELINE ORDER (tested explicitly - see chat.service.spec.ts's "pipeline
 * order" describe block, which uses a recording fake to assert the exact
 * call sequence below):
 *
 *   [ApiKeyGuard, already run before handle() is ever called: per-IP
 *    limiter -> key lookup -> per-key limiter]
 *   1. database-configured check (503 NOT_CONFIGURED) - before any run,
 *      before even body validation, since nothing else can proceed anyway.
 *   2. body validation (ChatRequestSchema.safeParse - 400 INVALID_REQUEST,
 *      generic message, never echoes the input back).
 *   3. identity resolution (a present-but-invalid customer token is ALWAYS
 *      401 INVALID_CUSTOMER_TOKEN, uniform regardless of which check
 *      failed; no token at all is anonymous; a public-scope caller's
 *      customerRef body field is never consulted at all - resolveIdentity
 *      enforces this already). Verified against THIS REQUEST's own
 *      authenticated tenantId, never a client-supplied one.
 *   4. per-tenant rate limit, then (only if identified) per-customerRef
 *      rate limit - both checked before any conversation read.
 *   5. in-flight run limiter (429 BACKPRESSURE with Retry-After) - acquired
 *      before the conversation is even resolved, released in a finally
 *      that covers every path below it, including an exception.
 *   6. conversation resolution, tenant-scoped: an explicit conversationId
 *      that doesn't exist, or whose stored customerRef doesn't match this
 *      caller's (null-safe: anonymous vs anonymous matches, anonymous vs
 *      identified does not), silently starts a brand new conversation
 *      instead of erroring - never leaks whether an id belongs to another
 *      tenant/customer.
 *   7. conversation lock (409 CONVERSATION_BUSY) - released in a finally
 *      that covers every path below it, including an exception, so a
 *      thrown error never wedges a conversation shut.
 *   8. length cap (409 CONVERSATION_LENGTH_EXCEEDED) - before history is
 *      even loaded, let alone runAgent.
 *   9. history load (most recent historyWindowSize messages, PRIOR turns
 *      only - loaded BEFORE this turn's own customer message is persisted,
 *      specifically so it's never duplicated against RunAgentInput's own
 *      separate customerMessage field), then trimmed by historyMaxChars.
 *   10. persist the customer message - NOT best-effort: a failure here
 *       returns a generic INTERNAL_ERROR immediately (the lock/in-flight
 *       slot still release via their own finally blocks) rather than
 *       proceeding to spend an LLM call on a turn that was never recorded.
 *   11. build RunAgentDeps and call runAgent, raced against
 *       settings.httpDeadlineMs (an AbortController whose signal is BOTH
 *       the race's own timeout AND passed into RunAgentDeps.abortSignal,
 *       so losing the race actually aborts the in-flight generate() call,
 *       not just the caller's await). Losing this race returns a generic
 *       503-shaped REQUEST_TIMEOUT - should be unreachable in practice
 *       since httpDeadlineMs is always configured above runAgent's own
 *       totalDeadlineMs (runAgent's own AbortController is what actually
 *       guarantees termination); if it ever does fire, the abandoned run's
 *       eventual result is never persisted.
 *   12. persist the AgentRun, then the agent's reply message, then
 *       increment the conversation's messageCount by 2 (atomically bumping
 *       updatedAt too - the TTL clock). Stage 4 amendment C: when the
 *       result carries a proposedAction, the AgentRun write is retried
 *       once and, if it still fails, the customer gets a generic 503 and
 *       NO proposal at all - an approval nobody can see in the admin
 *       console must never silently "succeed". Every other write here
 *       (a non-proposal AgentRun, the agent message, the message-count
 *       increment) is best-effort: retried once, a distinct
 *       chat_persist_failed event logged (ids/codes only) on a second
 *       failure, but the real ChatResult is still returned to the customer.
 *   13. respond with the real ChatResult (including degraded, when set).
 */
@Injectable()
export class ChatService {
  private readonly logger = new Logger(ChatService.name);
  private readonly clock: () => Date;

  constructor(
    @Optional() @Inject(CONVERSATION_REPOSITORY) private readonly conversationRepository: ConversationRepository | undefined,
    @Optional() @Inject(MESSAGE_REPOSITORY) private readonly messageRepository: MessageRepository | undefined,
    @Optional() @Inject(AGENT_RUN_REPOSITORY) private readonly agentRunRepository: AgentRunRepository | undefined,
    @Optional() @Inject(CUSTOMER_PUBLIC_KEY_REPOSITORY) private readonly customerPublicKeyRepository: CustomerPublicKeyRepository | undefined,
    @Inject(LLM_PROVIDER) private readonly llmProvider: LlmProvider,
    /** Typed as just the one method RunAgentDeps.retrieve needs - @Inject keeps resolving the real PolicyRetrievalService class in production, while tests can pass a plain { retrieve: async (...) => ... } fake instead of constructing the real service. */
    @Inject(PolicyRetrievalService) private readonly policyRetrievalService: Pick<PolicyRetrievalService, 'retrieve'>,
    @Inject(CONNECTOR_CONFIG_REPOSITORY) private readonly connectorConfigRepository: ConnectorConfigRepository,
    /** Typed as the minimal ToolRunnerLike shape, not the concrete ReadOnlyToolRunner class - that's all RunAgentDeps.toolRunner actually needs, and it lets tests substitute a plain fake (same pattern run-agent.spec.ts's own FakeToolRunner already uses) instead of constructing a real one. The real DI token (READ_ONLY_TOOL_RUNNER) still provides an actual ReadOnlyToolRunner instance in production. */
    @Inject(READ_ONLY_TOOL_RUNNER) private readonly toolRunner: ToolRunnerLike,
    @Inject(CHAT_SETTINGS) private readonly settings: ChatSettings,
    @Inject(RUN_AGENT_SETTINGS) private readonly runAgentSettings: RunAgentSettings,
    @Inject(DAILY_GENERATE_BUDGET) private readonly dailyGenerateBudget: DailyGenerateBudgetGuard,
    @Inject(TENANT_GENERATE_BUDGET) private readonly tenantGenerateBudget: DailyGenerateBudgetGuard,
    @Inject(TENANT_RATE_LIMITER) private readonly tenantRateLimiter: RateLimiter,
    @Inject(CUSTOMER_REF_RATE_LIMITER) private readonly customerRefRateLimiter: RateLimiter,
    @Inject(IN_FLIGHT_RUN_LIMITER) private readonly inFlightRunLimiter: InFlightRunLimiter,
    @Inject(CONVERSATION_LOCK) private readonly conversationLock: ConversationLock,
    /** Stage 5 - tenant-level refund settings (refundCap, approvalThreshold, refundWindowDays, autoExecuteRefunds, dailyRefundCountLimit, approvalExpiryDays) for ApprovalProposalPort.createFromProposal's own input. @Optional() - same "safe to import with no database" reasoning as every other DB-backed dependency above. */
    @Optional() @Inject(TENANT_REPOSITORY) private readonly tenantRepository: TenantRepository | undefined,
    /**
     * Stage 5, amendment G3 - the ONLY thing this service depends on from the approvals module:
     * a single method, never the whole ApprovalService (which also exposes the admin-decision
     * surface this chat path has no business touching). @Optional() because ApprovalsModule may
     * not be wired into every environment that constructs ChatService (e.g. a future standalone
     * deployment, or today's unit tests, which pass fakes instead) - handled the same "safe to
     * import, fails at the call site" way the database-backed dependencies above already are:
     * see persistRefundProposalAndRespond's own NOT_CONFIGURED-style guard.
     */
    @Optional() @Inject(APPROVAL_PROPOSAL_PORT) private readonly approvalProposalPort: ApprovalProposalPort | undefined,
    @Optional() clock?: () => Date,
  ) {
    this.clock = clock ?? (() => new Date());
  }

  async handle(input: ChatHandleInput): Promise<ChatHandleResult> {
    // 1. Database-configured check - before any run, before even body validation.
    if (!this.conversationRepository || !this.messageRepository || !this.agentRunRepository || !this.customerPublicKeyRepository) {
      return this.error('NOT_CONFIGURED', 'The database is not configured.');
    }
    const conversationRepository = this.conversationRepository;
    const messageRepository = this.messageRepository;
    const agentRunRepository = this.agentRunRepository;

    // 2. Body validation.
    const parsed = ChatRequestSchema.safeParse(input.rawBody);
    if (!parsed.success) {
      return this.error('INVALID_REQUEST', GENERIC_INVALID_REQUEST_MESSAGE);
    }
    const body = parsed.data;

    // 3. Identity resolution.
    const identity = await this.resolveIdentityAsync(input.tenantId, input.matchedScope, body);
    if (identity.kind === 'invalid_token') {
      return this.error('INVALID_CUSTOMER_TOKEN', 'The customer token is invalid, expired, or could not be verified.');
    }
    const verifiedCustomerRef = identity.kind === 'identified' ? identity.customerRef : undefined;

    // 4. Per-tenant, then per-customerRef rate limits.
    const tenantDecision = this.tenantRateLimiter.tryConsume(input.tenantId);
    if (!tenantDecision.allowed) {
      return this.error('RATE_LIMITED', 'Too many requests for this tenant.', msToSeconds(tenantDecision.retryAfterMs));
    }
    if (verifiedCustomerRef) {
      const customerDecision = this.customerRefRateLimiter.tryConsume(verifiedCustomerRef);
      if (!customerDecision.allowed) {
        return this.error('RATE_LIMITED', 'Too many requests for this customer.', msToSeconds(customerDecision.retryAfterMs));
      }
    }

    // 5. In-flight run limiter.
    const inFlight = this.inFlightRunLimiter.tryEnter();
    if (!inFlight.allowed) {
      return this.error('BACKPRESSURE', 'The service is at capacity. Please try again shortly.', inFlight.retryAfterSeconds);
    }

    try {
      return await this.runLockedPipeline(input.tenantId, verifiedCustomerRef, body, conversationRepository, messageRepository, agentRunRepository);
    } finally {
      inFlight.release();
    }
  }

  private async runLockedPipeline(
    tenantId: string,
    verifiedCustomerRef: string | undefined,
    body: ChatRequest,
    conversationRepository: ConversationRepository,
    messageRepository: MessageRepository,
    agentRunRepository: AgentRunRepository,
  ): Promise<ChatHandleResult> {
    // 6. Conversation resolution.
    const conversation = await this.resolveConversation(conversationRepository, tenantId, body.conversationId, verifiedCustomerRef);

    // 7. Conversation lock.
    const lock = this.conversationLock.tryAcquire(conversation.id);
    if (!lock.acquired) {
      // A fixed, small hint (not derived from any real queue position - the
      // lock itself has no concept of one) - this is a transient condition
      // worth retrying shortly, unlike CONVERSATION_LENGTH_EXCEEDED below,
      // which never carries a retryAfterSeconds since retrying won't help.
      return this.error('CONVERSATION_BUSY', 'Another request for this conversation is already being processed.', 2);
    }

    try {
      // 8. Length cap.
      if (conversation.messageCount + 2 > this.settings.maxMessagesPerConversation) {
        return this.error('CONVERSATION_LENGTH_EXCEEDED', 'This conversation has reached its maximum length.');
      }

      // 9. History load - PRIOR turns only, loaded before this turn is persisted.
      const historyRecords = await messageRepository.findRecentForConversation(tenantId, conversation.id, this.settings.historyWindowSize);
      const history = capHistoryByChars(
        historyRecords.map((m) => ({ role: m.role, text: m.content })),
        this.settings.historyMaxChars,
      );

      // 10. Persist the customer message - not best-effort.
      try {
        await messageRepository.create(tenantId, conversation.id, 'customer', body.message);
      } catch (err) {
        this.logPersistFailed('customer_message', tenantId, conversation.id, err);
        return this.error('INTERNAL_ERROR', GENERIC_INTERNAL_ERROR_MESSAGE);
      }

      // 11. Build RunAgentDeps and call runAgent, raced against the HTTP deadline backstop.
      const runId = generateRunId();
      const abortController = new AbortController();
      const deadlineTimer = setTimeout(() => abortController.abort(), this.settings.httpDeadlineMs);
      const startedAt = this.clock().getTime();

      const deps: RunAgentDeps = {
        llmProvider: this.llmProvider,
        retrieve: (tid, query, options) => this.policyRetrievalService.retrieve(tid, query, options),
        toolRunner: this.toolRunner,
        connectorConfigRepository: this.connectorConfigRepository,
        clock: this.clock,
        logEvent: (event) => this.logger.log(JSON.stringify(event)),
        settings: this.runAgentSettings,
        dailyGenerateBudget: this.dailyGenerateBudget,
        tenantGenerateBudget: this.tenantGenerateBudget,
        abortSignal: abortController.signal,
      };

      let raced: { timedOut: false; value: Awaited<ReturnType<typeof runAgentFn>> } | { timedOut: true };
      try {
        raced = await raceTimeout(
          runAgentFn({ tenantId, conversationId: conversation.id, runId, customerMessage: body.message, history, verifiedCustomerRef }, deps),
          this.settings.httpDeadlineMs,
        );
      } finally {
        clearTimeout(deadlineTimer);
      }

      if (raced.timedOut) {
        this.logger.warn(JSON.stringify({ event: 'chat_http_deadline_exceeded', tenantId, conversationId: conversation.id, runId }));
        return this.error('REQUEST_TIMEOUT', GENERIC_INTERNAL_ERROR_MESSAGE);
      }

      const { result, trace } = raced.value;
      const latencyMs = this.clock().getTime() - startedAt;

      // 12. Persist the run, the agent message, and the message-count increment.
      return await this.persistRunAndRespond(
        tenantId,
        conversation.id,
        result,
        trace,
        latencyMs,
        verifiedCustomerRef,
        agentRunRepository,
        messageRepository,
        conversationRepository,
      );
    } finally {
      lock.release();
    }
  }

  private async persistRunAndRespond(
    tenantId: string,
    conversationId: string,
    result: ChatResult,
    trace: AgentTrace,
    latencyMs: number,
    verifiedCustomerRef: string | undefined,
    agentRunRepository: AgentRunRepository,
    messageRepository: MessageRepository,
    conversationRepository: ConversationRepository,
  ): Promise<ChatHandleResult> {
    // Stage 5 - the ONE new seam. Milestone 3's own proposedAction-carrying 'pending_approval'
    // means "a candidate proposal survived basic sanity", not "a human will see this" - the
    // tenant policy gate (ApprovalProposalPort.createFromProposal) runs here, one layer up from
    // runAgent, which stays exactly as Milestone 3 built it. Every other outcome is completely
    // unaffected - see persistOrdinaryRunAndRespond below, unchanged from Milestone 3.
    if (result.outcome === 'pending_approval') {
      return await this.persistRefundProposalAndRespond(
        tenantId,
        conversationId,
        result,
        trace,
        latencyMs,
        verifiedCustomerRef,
        agentRunRepository,
        messageRepository,
        conversationRepository,
      );
    }

    const { tokensIn, tokensOut } = sumTokenUsage(trace.steps);
    const newRun: NewAgentRun = {
      tenantId,
      conversationId,
      outcome: result.outcome,
      ...(result.degraded ? { degraded: result.degraded } : {}),
      stepCount: trace.steps.length,
      llmCallCount: trace.llmCallCount,
      tokensIn,
      tokensOut,
      latencyMs,
      steps: trace.steps,
    };

    // Best-effort for every non-proposal outcome - the customer still gets the real result even
    // if this write fails (Milestone 3's original rule; the mandatory-write path only ever
    // applied to a proposedAction-carrying run, which can no longer reach this branch at all -
    // see the pending_approval dispatch above).
    const runWrite = await withOneRetry(() => agentRunRepository.create(newRun));
    if (!runWrite.ok) {
      this.logPersistFailed('agent_run', tenantId, conversationId, runWrite.error);
    }

    return await this.finalizeResponse(tenantId, conversationId, result, messageRepository, conversationRepository);
  }

  /**
   * Stage 5 - runs whenever runAgent proposes a refund. Calls
   * ApprovalProposalPort.createFromProposal exactly once (amendment C's mandatory-write policy
   * now covers the WHOLE call, not just the AgentRun piece - see approval.service.ts's own doc
   * comment on createApprovalRow for why retrying the whole call is safe), maps its disposition
   * to the real customer-facing outcome, and never calls agentRunRepository.create itself for
   * this path - the AgentRun write happens INSIDE createFromProposal, in the same transaction as
   * any Approval row it creates (persistAgentRunForRun below is the callback that performs it).
   */
  private async persistRefundProposalAndRespond(
    tenantId: string,
    conversationId: string,
    result: ChatResult,
    trace: AgentTrace,
    latencyMs: number,
    verifiedCustomerRef: string | undefined,
    agentRunRepository: AgentRunRepository,
    messageRepository: MessageRepository,
    conversationRepository: ConversationRepository,
  ): Promise<ChatHandleResult> {
    if (!this.approvalProposalPort || !this.tenantRepository) {
      return this.error('NOT_CONFIGURED', 'The database is not configured.');
    }
    // runAgent only ever reaches outcome: 'pending_approval' via validateProposedRefund, which
    // requires the order id to already be in verifiedOrderIds - itself only ever populated when
    // the caller has a verified identity. Both are therefore guaranteed present here.
    const proposedAction = result.proposedAction!;
    const snapshot = trace.proposedOrderSnapshot!;
    const customerRef = verifiedCustomerRef!;

    const tenant = await this.tenantRepository.findById(tenantId);
    if (!tenant) {
      // Resolved from an already-authenticated API key - should never actually be missing, but
      // fail safe rather than guess tenant settings if it somehow is.
      return this.error('INTERNAL_ERROR', GENERIC_INTERNAL_ERROR_MESSAGE);
    }

    const { tokensIn, tokensOut } = sumTokenUsage(trace.steps);
    const baseRunFields = {
      tenantId,
      conversationId,
      stepCount: trace.steps.length,
      llmCallCount: trace.llmCallCount,
      tokensIn,
      tokensOut,
      latencyMs,
      steps: trace.steps,
      proposedAction: toNewAgentRunProposedAction(proposedAction),
    };

    // The AgentRun's own `outcome` reflects what's known at THIS exact write (inside
    // createFromProposal, before any execution attempt for auto_execute) - 'escalate' for
    // denied/already_pending (the final answer, already decided), 'pending_approval' for
    // require_approval/auto_execute (genuinely not yet resolved at write time - Milestone 6
    // follows refundDisposition.approvalId to the Approval record for the eventual result,
    // exactly as PROJECT.md's Milestone 4 design documents).
    const persistAgentRunForRun: PersistAgentRunForProposal = async (disposition, session) => {
      const outcome: ChatResult['outcome'] = disposition.kind === 'denied' || disposition.kind === 'already_pending' ? 'escalate' : 'pending_approval';
      const refundDisposition: NewAgentRunRefundDisposition = toNewAgentRunRefundDisposition(disposition);
      await agentRunRepository.create({ ...baseRunFields, outcome, refundDisposition }, session);
    };

    const proposalWrite = await withOneRetry(() =>
      this.approvalProposalPort!.createFromProposal(
        {
          tenantId,
          runId: result.runId,
          conversationId,
          orderId: proposedAction.args.order_id,
          verifiedCustomerRef: customerRef,
          amountCents: toCents(proposedAction.args.amount),
          citations: result.citations.map((c) => c.chunkKey),
          orderSnapshot: {
            status: snapshot.status,
            customerRef: snapshot.customerRef,
            deliveredAt: snapshot.deliveredAt,
            totalCents: snapshot.totalCents,
            alreadyRefundedCents: snapshot.alreadyRefundedCents,
          },
          tenantSettings: {
            refundCap: tenant.refundCap ?? 0,
            approvalThreshold: tenant.approvalThreshold ?? 0,
            refundWindowDays: tenant.refundWindowDays ?? 0,
            autoExecuteRefunds: tenant.autoExecuteRefunds ?? false,
            ...(tenant.dailyRefundCountLimit !== undefined ? { dailyRefundCountLimit: tenant.dailyRefundCountLimit } : {}),
          },
          approvalExpiryDays: tenant.approvalExpiryDays ?? 7,
          now: this.clock(),
        },
        persistAgentRunForRun,
      ),
    );

    if (!proposalWrite.ok) {
      // Amendment C, extended to the whole proposal call (Stage 5) - an approval nobody can see,
      // or an AgentRun with no corresponding real decision, must never silently "succeed" for
      // the customer. No proposal reaches them at all.
      this.logPersistFailed('agent_run_mandatory', tenantId, conversationId, proposalWrite.error);
      return this.error('PENDING_APPROVAL_WRITE_FAILED', 'Unable to record this request. Please try again.');
    }

    const finalResult = this.buildFinalResultForDisposition(result, proposalWrite.value);
    return await this.finalizeResponse(tenantId, conversationId, finalResult, messageRepository, conversationRepository);
  }

  /** Maps createFromProposal's disposition to the real customer-facing ChatResult - never the original runAgent 'pending_approval' result as-is, except for the genuine require_approval case. */
  private buildFinalResultForDisposition(original: ChatResult, disposition: CreateFromProposalResult): ChatResult {
    const base = { conversationId: original.conversationId, runId: original.runId, citations: original.citations };
    switch (disposition.kind) {
      case 'denied':
        return { ...base, outcome: 'escalate', message: GENERIC_ESCALATE_MESSAGE };
      case 'already_pending':
        return { ...base, outcome: 'escalate', message: disposition.message };
      case 'pending_approval':
        return { ...base, outcome: 'pending_approval', message: disposition.message, proposedAction: original.proposedAction };
      case 'auto_executed':
        return disposition.success
          ? { ...base, outcome: 'reply', message: disposition.message }
          : { ...base, outcome: 'escalate', message: GENERIC_ESCALATE_MESSAGE };
    }
  }

  /** Shared tail: best-effort agent message append + message-count increment, same as Milestone 3's original persistRunAndRespond for every outcome. */
  private async finalizeResponse(
    tenantId: string,
    conversationId: string,
    result: ChatResult,
    messageRepository: MessageRepository,
    conversationRepository: ConversationRepository,
  ): Promise<ChatHandleResult> {
    const messageWrite = await withOneRetry(() => messageRepository.create(tenantId, conversationId, 'agent', result.message));
    if (!messageWrite.ok) {
      this.logPersistFailed('agent_message', tenantId, conversationId, messageWrite.error);
    }

    const countWrite = await withOneRetry(() => conversationRepository.incrementMessageCount(tenantId, conversationId, 2));
    if (!countWrite.ok) {
      this.logPersistFailed('message_count', tenantId, conversationId, countWrite.error);
    }

    return { kind: 'success', body: result };
  }

  private async resolveConversation(
    conversationRepository: ConversationRepository,
    tenantId: string,
    requestedId: string | undefined,
    verifiedCustomerRef: string | undefined,
  ): Promise<ConversationRecord> {
    if (requestedId) {
      const existing = await conversationRepository.findById(tenantId, requestedId);
      // Null-safe ownership check: anonymous (null) matches anonymous,
      // never matches an identified customerRef and vice versa. A mismatch
      // or an unknown id both silently fall through to creating a new
      // conversation below - never an error, never a signal distinguishing
      // "doesn't exist" from "belongs to someone else".
      if (existing && (existing.customerRef ?? null) === (verifiedCustomerRef ?? null)) {
        return existing;
      }
    }
    return conversationRepository.create(tenantId, verifiedCustomerRef ?? null);
  }

  /**
   * verifyCustomerToken/resolveIdentity require a SYNCHRONOUS
   * lookupPublicKey, but CustomerPublicKeyRepository.findActive is
   * necessarily async (a database read). Peeks the token's own unverified
   * `kid` claim (unverified-kid.ts), fetches exactly that one key async,
   * then hands resolveIdentity a synchronous closure over the
   * already-fetched value - never a live async call from inside
   * resolveIdentity's own synchronous call stack.
   */
  private async resolveIdentityAsync(tenantId: string, scope: ApiKeyScope, body: Pick<ChatRequest, 'customerRef' | 'customerToken'>): Promise<IdentityResolution> {
    let cachedKid: number | undefined;
    let cachedPublicKeyX: string | undefined;

    if (scope === 'public' && body.customerToken) {
      cachedKid = peekUnverifiedKid(body.customerToken);
      if (cachedKid !== undefined) {
        cachedPublicKeyX = await this.customerPublicKeyRepository!.findActive(tenantId, cachedKid);
      }
    }

    const lookupPublicKey: LookupPublicKey = (_tenantId, requestedKid) => (requestedKid === cachedKid ? cachedPublicKeyX : undefined);
    return resolveIdentity(scope, body, tenantId, lookupPublicKey, this.clock);
  }

  private logPersistFailed(stage: string, tenantId: string, conversationId: string, error: unknown): void {
    const code = error instanceof Error ? error.message : String(error);
    this.logger.error(JSON.stringify({ event: 'chat_persist_failed', stage, tenantId, conversationId, code }));
  }

  private error(code: ChatErrorCode, message: string, retryAfterSeconds?: number): ChatHandleResult {
    return { kind: 'error', code, message, ...(retryAfterSeconds !== undefined ? { retryAfterSeconds } : {}) };
  }
}

function msToSeconds(ms: number): number {
  return Math.ceil(ms / 1000);
}
