import {
  ChatResult,
  ComposeOutput,
  ComposeOutputSchema,
  DegradedReason,
  GetOrderOutput,
  MAX_CHAT_MESSAGE_LENGTH,
  PlannerOutput,
  PlannerOutputSchema,
  RetrievalResult,
  TrackShipmentOutput,
  toGeminiResponseJsonSchema,
} from '@supportpilot/shared';
import { z } from 'zod';
import { ConnectorConfigRepository } from '../../connectors/connector-config.repository';
import { GenerateErrorCode, LlmProvider } from '../../llm/llm-provider.interface';
import { ToolRunResult } from '../tool-runner/tool-runner';
import { allowedPlannerTools } from '../planner/allowed-tools';
import { newBoundary } from '../prompt/boundary';
import { buildSystemInstruction } from '../prompt/system-instruction';
import { buildComposeUserContent, buildPlanUserContent, HistoryTurn, ToolResultFact } from '../prompt/user-content';
import { buildPendingApprovalMessage } from './build-pending-approval-message';
import { guardCitations } from './citation-guard';
import { DailyGenerateBudgetGuard } from './daily-generate-budget';
import { daysPastEstimate, daysSinceDelivery, remainingRefundable } from './derived-facts';
import { buildGroundingFacts, checkMessageGrounding } from './message-grounding';
import { acceptOrderResult, assertToolRequestAllowed, OwnershipState } from './ownership';
import { validateProposedRefund } from './validate-proposed-refund';

/** The minimal surface runAgent needs from ReadOnlyToolRunner - lets tests substitute a plain fake rather than a real instance. */
export interface ToolRunnerLike {
  run(tenantId: string, toolName: string, args: Record<string, unknown>): Promise<ToolRunResult>;
}

export type { HistoryTurn };

export interface RetrieveOptions {
  topK?: number;
  exact?: boolean;
}
export type RetrieveOutcome = { ok: true; results: RetrievalResult[] } | { ok: false; error: { code: string; message: string } };

export interface RunAgentInput {
  tenantId: string;
  conversationId: string;
  runId: string;
  customerMessage: string;
  history: HistoryTurn[];
  /** undefined when the caller has no verified customer identity this turn - anonymous/public callers without a valid token. */
  verifiedCustomerRef: string | undefined;
}

export interface RunAgentSettings {
  /** Per generate() call - PROJECT.md's Agent loop design, amendment H. Still enforced, but the run-level AbortSignal below is what actually bounds total retry time within one call - see runAgent's own doc comment. */
  perLlmCallTimeoutMs: number;
  /** Total wall-clock budget for the whole run, across every step. A single AbortController, created once per run and shared across every generate() call, is what makes this hold even through retries/backoff - see runAgent's own doc comment. */
  totalDeadlineMs: number;
  /** runAgent's own timeout around the retrieval call - PolicyRetrievalService.retrieve() has no timeout of its own. Actually applied as min(this, time remaining until the run deadline) - see Stage 4 finding 6. */
  retrievalTimeoutMs: number;
  /** How many times a per-call TIMEOUT (not ABORTED) may be retried - see run-agent.settings.ts and the TIMEOUT/ABORTED split in llm-provider.interface.ts's GenerateErrorCode doc comment (Stage 4 finding B). */
  timeoutMaxRetries: number;
  generateMaxOutputTokens: number;
  generateTemperature: number;
  /** Omitted means "let the model use its own default" - see LlmSettings.generateThinkingLevel's doc comment (Stage 4 finding C). */
  generateThinkingLevel?: 'minimal' | 'low' | 'medium' | 'high';
  retrievalTopK?: number;
}

export interface RunAgentDeps {
  llmProvider: LlmProvider;
  retrieve: (tenantId: string, query: string, options?: RetrieveOptions) => Promise<RetrieveOutcome>;
  toolRunner: ToolRunnerLike;
  connectorConfigRepository: ConnectorConfigRepository;
  clock: () => Date;
  /** ids, counts, codes, and durations only - never prompts, responses, or customer text. See run-agent.spec.ts's log-capture test. */
  logEvent: (event: Record<string, unknown>) => void;
  settings: RunAgentSettings;
  /** Checked before every real generate() attempt (plan, repair, compose) - see Stage 4 finding 7 and daily-generate-budget.ts's own doc comment. */
  dailyGenerateBudget: DailyGenerateBudgetGuard;
  /**
   * Stage 4 item 2 - the per-tenant layer, checked BEFORE dailyGenerateBudget
   * (the shared, cross-tenant layer) on every real generate() attempt.
   * Optional so every existing test/caller that only cares about the
   * global guard keeps working unchanged - omitting it simply means "no
   * per-tenant limit is enforced," never a denial. Kept as a separate
   * dependency (rather than folding both layers into one opaque
   * TenantAndGlobalGenerateBudgetGuard call) specifically so runAgent can
   * tell which layer denied a call and report a distinct
   * TENANT_BUDGET_EXCEEDED vs DAILY_BUDGET_EXCEEDED degraded reason - a
   * single boolean from a combined guard couldn't carry that distinction.
   */
  tenantGenerateBudget?: DailyGenerateBudgetGuard;
  /**
   * Stage 5 - an external deadline (chat.service.ts's httpDeadlineMs
   * backstop) that aborts this run the same way the internal
   * totalDeadlineMs timer does. Optional so every existing caller/test
   * that has no outer deadline of its own is unaffected.
   */
  abortSignal?: AbortSignal;
}

export type AgentStepType = 'plan' | 'retrieve' | 'tool' | 'compose' | 'repair' | 'escalation_tool';

export interface AgentStepTrace {
  type: AgentStepType;
  durationMs: number;
  /** 'OK' on success, otherwise a failure code - never prompt or response text. */
  outcomeCode: string;
  toolName?: string;
  orderId?: string;
  citedChunkKeys?: string[];
  tokenUsage?: { inputTokens: number; outputTokens: number };
  /** Only present for plan/compose/repair steps that failed - how many attempts (including the final one) the provider's own retry logic made before giving up. */
  attempts?: number;
}

export interface AgentTrace {
  steps: AgentStepTrace[];
  llmCallCount: number;
}

export interface RunAgentResult {
  result: ChatResult;
  trace: AgentTrace;
}

const GENERIC_ESCALATE_MESSAGE = "I'm not able to help with this directly, so I've flagged it for a team member to follow up with you.";
/** Stage 4 finding 7 - distinct from the generic escalate message above, so this cause stays distinguishable to anyone reading the chat, not just the trace/logs. */
const DAILY_BUDGET_MESSAGE = "Our automated assistant has reached its demo usage limit for today. I've flagged this for a team member to follow up with you.";
/** Stage 4 item 2 - distinct from DAILY_BUDGET_MESSAGE above: this tenant's own allowance is spent, not the shared cross-tenant pool. */
const TENANT_BUDGET_MESSAGE = "Our automated assistant has reached its usage limit for your account today. I've flagged this for a team member to follow up with you.";
/** Stage 4 finding 3 - distinct from both messages above: the circuit breaker, not the daily budget, decided no real call should be attempted right now. runAgent must still reach this message in well under a second, since beforeCall()'s rejection never touches the network. */
const CIRCUIT_OPEN_MESSAGE = "Our automated assistant is temporarily unavailable. I've flagged this for a team member to follow up with you shortly.";
/**
 * Stage 4 finding 5 - the safe fallback for a reply/clarify message that
 * named an order id or dollar amount nothing in the run actually supports
 * (message-grounding.ts). This replaces only the TEXT, never the outcome -
 * the run still ends in whatever outcome compose chose, just without the
 * unsupported claim reaching the customer.
 */
const UNGROUNDED_MESSAGE_FALLBACK = "Let me double check those details before confirming anything specific - a team member will follow up shortly.";

export type EscalationReasonCode =
  | 'INVALID_INPUT'
  | 'PLAN_LLM_ERROR'
  | 'COMPOSE_LLM_ERROR'
  | 'INVALID_STRUCTURED_OUTPUT'
  | 'DEADLINE_EXCEEDED'
  | 'MODEL_REQUESTED_ESCALATION'
  | 'REFUND_PROPOSAL_REJECTED'
  /** Stage 4 finding 4 - compose said `reply` with no citation and no successful tool result behind it: an assertion with nothing supporting it, never passed through as-is. */
  | 'REPLY_NOT_GROUNDED'
  /** Stage 4 finding 7 - the daily generate budget guard (the shared, cross-tenant layer) denied this attempt before any real Gemini call was made. */
  | 'DAILY_BUDGET_EXCEEDED'
  /** Stage 4 item 2 - this tenant's own per-tenant budget guard denied this attempt before any real Gemini call was made, and before the shared layer was even checked. */
  | 'TENANT_BUDGET_EXCEEDED'
  /** Stage 4 finding 3 - the provider's circuit breaker rejected this attempt before any real Gemini call was made. */
  | 'CIRCUIT_OPEN';

/** GenerateErrorCode plus two purely local codes for a request callStructured's own attempt() never sent to the real provider at all - see Stage 4 findings 7 and item 2. */
type AttemptErrorCode = GenerateErrorCode | 'DAILY_BUDGET_EXCEEDED' | 'TENANT_BUDGET_EXCEEDED';

/**
 * Stage 4 item 3 - maps an EscalationReasonCode to the `degraded` value
 * ChatResultSchema exposes, or undefined for an ordinary business-reason
 * escalation (no usage/availability cause, nothing to report beyond the
 * outcome itself). LLM_UNAVAILABLE deliberately covers every other
 * generate()-related reason (PLAN_LLM_ERROR/COMPOSE_LLM_ERROR's own default
 * branch - timeout after retries exhausted, rate-limited, unauthorized,
 * not configured, ABORTED - and INVALID_STRUCTURED_OUTPUT, invalid output
 * surviving one repair attempt) per PROJECT.md's Stage 4 amendment D.
 */
function degradedReasonFor(reasonCode: EscalationReasonCode): DegradedReason | undefined {
  switch (reasonCode) {
    case 'DAILY_BUDGET_EXCEEDED':
    case 'TENANT_BUDGET_EXCEEDED':
    case 'CIRCUIT_OPEN':
      return reasonCode;
    case 'PLAN_LLM_ERROR':
    case 'COMPOSE_LLM_ERROR':
    case 'INVALID_STRUCTURED_OUTPUT':
      return 'LLM_UNAVAILABLE';
    default:
      return undefined;
  }
}

interface OrderFacts {
  status: string;
  totalCents: number;
  alreadyRefundedCents: number;
  deliveredAt?: string;
}

interface ShipmentFacts {
  status: string;
  estimatedDelivery?: string;
}

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/**
 * Only ever called via the specific sub-rejection codes this module
 * produces itself - never raw customer or model text, never a prompt or
 * response. PROJECT.md's Agent loop design: "escalate_to_human (code, not
 * the model) with a summary built from structured facts only."
 */
function buildEscalationSummary(reasonCode: string, orderId: string | undefined): string {
  return orderId ? `reasonCode=${reasonCode} orderId=${orderId}` : `reasonCode=${reasonCode}`;
}

/**
 * The internal, HTTP-free, database-free entry point to the agent engine -
 * the same one `POST /v1/chat` calls (Stage 5) and the one the Milestone 6
 * evaluation harness calls directly. Every dependency is injected; nothing
 * here reads the real clock, calls a real LLM, or touches a database.
 *
 * Pipeline: validate input -> plan (LLM call 1) -> code filters tool
 * requests -> retrieval (if needsPolicy) -> read-only tools (concurrent
 * within each ownership phase) -> derived facts in code -> compose (LLM
 * call 2) -> citation guard -> grounding gate -> outcome finalization. See
 * this file's tests for the full failure matrix.
 *
 * DEADLINE ENFORCEMENT - a real bug, found by running the real
 * agent-pipeline-smoke-test against the real API: `pastDeadline()` checks
 * between steps are not enough on their own, because they can never
 * interrupt a single `generate()` call already in flight - and a
 * generate() call that keeps hitting 429s can spend its ENTIRE
 * retry/backoff budget (tens of seconds) before returning, regardless of
 * how much of the run's own deadline is left. The fix: one
 * `AbortController`, created ONCE here and shared across every generate()
 * call this run makes (plan, repair, compose) via `GenerateOptions.abortSignal` -
 * when the run's deadline fires, it aborts whichever call is in flight
 * AND makes ThrottledClient's retry/backoff loop stop immediately instead
 * of sleeping out its full backoff schedule (see that class's own doc
 * comment). The timer is cleared in `finally` on every return path.
 *
 * Stage 4 finding 6 extends the SAME deadline to retrieval and tool calls,
 * neither of which the AbortController above ever covered: both now race
 * against `min(their own configured timeout, time actually remaining
 * until deadlineAt)`, computed fresh right before each one starts, so a
 * slow retrieval or a hanging tool call can no longer push a run past its
 * total deadline either.
 */
export async function runAgent(input: RunAgentInput, deps: RunAgentDeps): Promise<RunAgentResult> {
  const steps: AgentStepTrace[] = [];
  let llmCallCount = 0;
  let repairUsed = false;
  const toolResultFacts: ToolResultFact[] = [];
  const orderFacts = new Map<string, OrderFacts>();
  const shipmentFacts = new Map<string, ShipmentFacts>();

  const startedAt = deps.clock().getTime();
  const deadlineAt = startedAt + deps.settings.totalDeadlineMs;
  const pastDeadline = (): boolean => deps.clock().getTime() >= deadlineAt;
  const remainingMs = (): number => Math.max(0, deadlineAt - deps.clock().getTime());

  const deadlineController = new AbortController();
  const deadlineTimer = setTimeout(() => deadlineController.abort(), deps.settings.totalDeadlineMs);

  // Stage 5 - an external signal (chat.service.ts's own httpDeadlineMs
  // backstop, always configured ABOVE totalDeadlineMs) can abort this run
  // too, so an abandoned HTTP request actually stops the in-flight
  // generate() call rather than merely orphaning the promise while it
  // keeps running unseen. Listener removal matters here, not just
  // clearTimeout: an AbortSignal with no listeners left attached is safe
  // to garbage-collect once this run returns - leaving one attached would
  // keep this whole closure (and deadlineController) alive for as long as
  // the caller's AbortController outlives this function, for every run.
  const onExternalAbort = () => deadlineController.abort();
  if (deps.abortSignal) {
    if (deps.abortSignal.aborted) {
      deadlineController.abort();
    } else {
      deps.abortSignal.addEventListener('abort', onExternalAbort);
    }
  }

  const boundary = newBoundary();
  const identityVerified = input.verifiedCustomerRef !== undefined;

  function logFinal(outcome: string, extra: Record<string, unknown> = {}): void {
    deps.logEvent({
      event: 'agent_run',
      tenantId: input.tenantId,
      conversationId: input.conversationId,
      runId: input.runId,
      outcome,
      stepCount: steps.length,
      llmCallCount,
      durationMs: deps.clock().getTime() - startedAt,
      ...extra,
    });
  }

  async function callEscalationTool(reasonCode: EscalationReasonCode, orderId: string | undefined): Promise<void> {
    const summary = buildEscalationSummary(reasonCode, orderId);
    const toolStartedAt = deps.clock().getTime();
    const result = await deps.toolRunner.run(input.tenantId, 'escalate_to_human', { summary });
    const durationMs = deps.clock().getTime() - toolStartedAt;
    const outcomeCode = result.ok ? 'OK' : result.error.code;
    steps.push({ type: 'escalation_tool', durationMs, outcomeCode, orderId });
    deps.logEvent({
      event: 'agent_escalation',
      tenantId: input.tenantId,
      runId: input.runId,
      reasonCode,
      toolOutcome: outcomeCode,
    });
    // A failed escalation handoff never changes what the customer sees -
    // they still get `escalate`, never something worse because an
    // internal handoff call failed. The failure is visible only in the
    // trace/log above, for operator visibility.
  }

  function buildResult(
    outcome: ChatResult['outcome'],
    message: string,
    citations: ChatResult['citations'],
    proposedAction: ChatResult['proposedAction'],
    degraded?: DegradedReason,
  ): ChatResult {
    return {
      conversationId: input.conversationId,
      runId: input.runId,
      outcome,
      message,
      citations,
      ...(proposedAction ? { proposedAction } : {}),
      ...(degraded ? { degraded } : {}),
    };
  }

  async function forcedEscalate(reasonCode: EscalationReasonCode, orderId: string | undefined, message: string = GENERIC_ESCALATE_MESSAGE): Promise<RunAgentResult> {
    await callEscalationTool(reasonCode, orderId);
    logFinal('escalate', { reasonCode });
    return { result: buildResult('escalate', message, [], undefined, degradedReasonFor(reasonCode)), trace: { steps, llmCallCount } };
  }

  type StructuredOutcome<T> = { kind: 'ok'; data: T } | { kind: 'llm_error'; code: AttemptErrorCode } | { kind: 'invalid_output' };

  async function callStructured<T>(schema: z.ZodType<T>, systemInstruction: string, userContent: string, stepType: 'plan' | 'compose'): Promise<StructuredOutcome<T>> {
    const responseSchema = toGeminiResponseJsonSchema(schema);

    /**
     * Stage 4 finding B - TIMEOUT (this call's own perLlmCallTimeoutMs
     * elapsed) and ABORTED (the run's own deadline fired) are now handled
     * differently: a TIMEOUT is retried, up to timeoutMaxRetries, as long
     * as the run still has deadline budget left when the retry is about
     * to start - a single slow call should get another chance, not end
     * the whole run. ABORTED is never retried - the run itself is out of
     * time. durationMs accumulates across every real attempt this call
     * made, so the trace reports the true total elapsed time, never just
     * the last attempt's.
     */
    async function attempt(sysInstr: string) {
      let totalDurationMs = 0;
      for (let timeoutRetry = 0; ; timeoutRetry++) {
        if (pastDeadline()) {
          return {
            outcome: { ok: false as const, error: { code: 'ABORTED' as const, message: 'Run deadline reached before this attempt could run.', attempts: undefined as number | undefined } },
            durationMs: totalDurationMs,
          };
        }

        // Stage 4 item 2 - tenant layer checked FIRST, and only when it
        // allows the call does the (shared, cross-tenant) global layer get
        // checked at all. Both denials are reported before any real
        // provider call is made; llmCallCount is deliberately not
        // incremented for either, since no real Gemini call happened.
        if (deps.tenantGenerateBudget && !deps.tenantGenerateBudget.tryConsume(input.tenantId)) {
          return {
            outcome: { ok: false as const, error: { code: 'TENANT_BUDGET_EXCEEDED' as const, message: 'Tenant daily generate budget exhausted.', attempts: undefined as number | undefined } },
            durationMs: totalDurationMs,
          };
        }

        if (!deps.dailyGenerateBudget.tryConsume(input.tenantId)) {
          // Stage 4 item 2 - the global layer denied it, so the tenant
          // ticket this attempt already spent is refunded: the tenant
          // never actually got to use its allowance this call.
          deps.tenantGenerateBudget?.release(input.tenantId);
          return {
            outcome: { ok: false as const, error: { code: 'DAILY_BUDGET_EXCEEDED' as const, message: 'Daily generate budget exhausted.', attempts: undefined as number | undefined } },
            durationMs: totalDurationMs,
          };
        }

        llmCallCount += 1;
        const attemptStartedAt = deps.clock().getTime();
        const outcome = await deps.llmProvider.generate({
          systemInstruction: sysInstr,
          messages: [{ role: 'user', text: userContent }],
          responseSchema,
          maxOutputTokens: deps.settings.generateMaxOutputTokens,
          temperature: deps.settings.generateTemperature,
          thinkingLevel: deps.settings.generateThinkingLevel,
          timeoutMs: deps.settings.perLlmCallTimeoutMs,
          abortSignal: deadlineController.signal,
        });
        totalDurationMs += deps.clock().getTime() - attemptStartedAt;

        if (!outcome.ok && outcome.error.code === 'CIRCUIT_OPEN') {
          // Stage 4 finding 3 - no real Gemini call happened at all, so the
          // ticket this attempt pre-consumed and the llmCallCount increment
          // above both get undone here, and this is never retried (there
          // is nothing to retry - the breaker rejected before any network
          // call). Falls straight through to forcedEscalate below via the
          // normal llm_error path. Both layers are released - both were
          // genuinely consumed to reach this point.
          deps.dailyGenerateBudget.release(input.tenantId);
          deps.tenantGenerateBudget?.release(input.tenantId);
          llmCallCount -= 1;
          return { outcome, durationMs: totalDurationMs };
        }

        if (!outcome.ok && outcome.error.code === 'TIMEOUT' && timeoutRetry < deps.settings.timeoutMaxRetries) {
          continue;
        }
        return { outcome, durationMs: totalDurationMs };
      }
    }

    const first = await attempt(systemInstruction);
    if (!first.outcome.ok) {
      steps.push({ type: stepType, durationMs: first.durationMs, outcomeCode: first.outcome.error.code, attempts: first.outcome.error.attempts });
      return { kind: 'llm_error', code: first.outcome.error.code };
    }

    const firstParsed = schema.safeParse(safeJsonParse(first.outcome.result.text));
    if (firstParsed.success) {
      steps.push({ type: stepType, durationMs: first.durationMs, outcomeCode: 'OK', tokenUsage: first.outcome.result.usage });
      return { kind: 'ok', data: firstParsed.data };
    }

    steps.push({ type: stepType, durationMs: first.durationMs, outcomeCode: 'INVALID_OUTPUT', tokenUsage: first.outcome.result.usage });

    if (repairUsed) {
      return { kind: 'invalid_output' };
    }
    repairUsed = true;

    const repairInstruction = `${systemInstruction}\n\nYour previous response did not match the required schema. Respond again with structured JSON only, matching the schema exactly.`;
    const repair = await attempt(repairInstruction);
    if (!repair.outcome.ok) {
      steps.push({ type: 'repair', durationMs: repair.durationMs, outcomeCode: repair.outcome.error.code, attempts: repair.outcome.error.attempts });
      return { kind: 'llm_error', code: repair.outcome.error.code };
    }

    const repairParsed = schema.safeParse(safeJsonParse(repair.outcome.result.text));
    if (!repairParsed.success) {
      steps.push({ type: 'repair', durationMs: repair.durationMs, outcomeCode: 'INVALID_OUTPUT', tokenUsage: repair.outcome.result.usage });
      return { kind: 'invalid_output' };
    }

    steps.push({ type: 'repair', durationMs: repair.durationMs, outcomeCode: 'OK', tokenUsage: repair.outcome.result.usage });
    return { kind: 'ok', data: repairParsed.data };
  }

  /** Both LLM-error branches (plan and compose) route a budget denial to its own distinct escalate message - everything else keeps its existing reasonCode/message. */
  async function escalateForLlmError(code: AttemptErrorCode, llmErrorReasonCode: EscalationReasonCode): Promise<RunAgentResult> {
    if (code === 'TENANT_BUDGET_EXCEEDED') {
      return await forcedEscalate('TENANT_BUDGET_EXCEEDED', undefined, TENANT_BUDGET_MESSAGE);
    }
    if (code === 'DAILY_BUDGET_EXCEEDED') {
      return await forcedEscalate('DAILY_BUDGET_EXCEEDED', undefined, DAILY_BUDGET_MESSAGE);
    }
    if (code === 'CIRCUIT_OPEN') {
      return await forcedEscalate('CIRCUIT_OPEN', undefined, CIRCUIT_OPEN_MESSAGE);
    }
    return await forcedEscalate(llmErrorReasonCode, undefined);
  }

  try {
    // --- 1. Validate input ---
    if (
      typeof input.customerMessage !== 'string' ||
      input.customerMessage.length === 0 ||
      input.customerMessage.length > MAX_CHAT_MESSAGE_LENGTH
    ) {
      return await forcedEscalate('INVALID_INPUT', undefined);
    }

    if (pastDeadline()) {
      return await forcedEscalate('DEADLINE_EXCEEDED', undefined);
    }

    // --- 2. Plan (LLM call 1) ---
    const configuredConnectors = deps.connectorConfigRepository.findAllForTenant(input.tenantId);
    const allowed = identityVerified ? allowedPlannerTools(configuredConnectors) : new Set<string>();

    const planSystemInstruction = buildSystemInstruction({ phase: 'plan', boundary, identityVerified, allowedTools: [...allowed] });
    const planUserContent = buildPlanUserContent(boundary, input.customerMessage, input.history);

    const planOutcome = await callStructured<PlannerOutput>(PlannerOutputSchema, planSystemInstruction, planUserContent, 'plan');
    if (planOutcome.kind === 'llm_error') {
      return await escalateForLlmError(planOutcome.code, 'PLAN_LLM_ERROR');
    }
    if (planOutcome.kind === 'invalid_output') {
      return await forcedEscalate('INVALID_STRUCTURED_OUTPUT', undefined);
    }
    const plan = planOutcome.data;

    if (pastDeadline()) {
      return await forcedEscalate('DEADLINE_EXCEEDED', undefined);
    }

    // --- 3. Code filters the tool requests ---
    const filteredRequests = plan.toolRequests.filter((request) => allowed.has(request.tool));

    // --- 4. Retrieval, if needsPolicy (own timeout, capped by the run's remaining deadline - Stage 4 finding 6) ---
    let retrievedChunks: RetrievalResult[] = [];
    if (plan.needsPolicy && plan.searchQuery) {
      const retrieveStartedAt = deps.clock().getTime();
      const outcome = await raceTimeout(deps.retrieve(input.tenantId, plan.searchQuery, { topK: deps.settings.retrievalTopK }), Math.min(deps.settings.retrievalTimeoutMs, remainingMs()));
      const durationMs = deps.clock().getTime() - retrieveStartedAt;
      if (outcome.timedOut) {
        steps.push({ type: 'retrieve', durationMs, outcomeCode: 'TIMEOUT' });
        toolResultFacts.push({ tool: 'retrieve_policy', ok: false, code: 'TIMEOUT' });
      } else if (outcome.value.ok) {
        retrievedChunks = outcome.value.results;
        steps.push({ type: 'retrieve', durationMs, outcomeCode: 'OK' });
      } else {
        steps.push({ type: 'retrieve', durationMs, outcomeCode: outcome.value.error.code });
        toolResultFacts.push({ tool: 'retrieve_policy', ok: false, code: outcome.value.error.code });
      }
    }

    // --- 5. Run allowed read-only tools. Phase A: get_order, concurrently - populates verifiedOrderIds. ---
    let ownershipState: OwnershipState = { verifiedCustomerRef: input.verifiedCustomerRef ?? '', verifiedOrderIds: new Set() };

    const getOrderRequests = filteredRequests.filter((r) => r.tool === 'get_order');
    const getOrderTimeoutMs = remainingMs();
    const getOrderResults = await Promise.all(getOrderRequests.map((r) => runToolTimed(deps, input.tenantId, 'get_order', { order_id: r.order_id }, getOrderTimeoutMs)));

    for (let i = 0; i < getOrderRequests.length; i++) {
      const orderId = getOrderRequests[i].order_id;
      const { result, durationMs } = getOrderResults[i];
      steps.push({ type: 'tool', toolName: 'get_order', orderId, durationMs, outcomeCode: result.ok ? 'OK' : result.error.code });

      if (!result.ok) {
        toolResultFacts.push({ tool: 'get_order', orderId, ok: false, code: result.error.code });
        continue;
      }

      const output = result.data as GetOrderOutput;
      const before = ownershipState.verifiedOrderIds.has(orderId);
      ownershipState = acceptOrderResult(ownershipState, orderId, output);
      const verified = ownershipState.verifiedOrderIds.has(orderId);

      if (!before && !verified) {
        // Ownership mismatch - reported as the exact same fact as "not
        // found," no distinguishing signal (PROJECT.md's Agent loop design).
        toolResultFacts.push({ tool: 'get_order', orderId, ok: false, code: 'NOT_FOUND' });
        continue;
      }

      orderFacts.set(orderId, { status: output.status, totalCents: output.total, alreadyRefundedCents: output.alreadyRefundedTotal, deliveredAt: output.deliveredAt });
      toolResultFacts.push({ tool: 'get_order', orderId, ok: true, code: 'OK', fields: { status: output.status } });
    }

    // --- Phase B: track_shipment, re-filtered against the now-populated verifiedOrderIds, concurrently. ---
    const trackShipmentRequests = filteredRequests.filter((r) => r.tool === 'track_shipment');
    const allowedTrackShipment = trackShipmentRequests.filter((r) => assertToolRequestAllowed(r, ownershipState.verifiedOrderIds).allowed);
    const deniedTrackShipment = trackShipmentRequests.filter((r) => !assertToolRequestAllowed(r, ownershipState.verifiedOrderIds).allowed);

    for (const denied of deniedTrackShipment) {
      // Same "not found"-shaped fact as any other unverified-order denial - never a distinct "you weren't allowed to ask that" signal.
      toolResultFacts.push({ tool: 'track_shipment', orderId: denied.order_id, ok: false, code: 'NOT_FOUND' });
    }

    const trackShipmentTimeoutMs = remainingMs();
    const trackShipmentResults = await Promise.all(
      allowedTrackShipment.map((r) => runToolTimed(deps, input.tenantId, 'track_shipment', { order_id: r.order_id }, trackShipmentTimeoutMs)),
    );

    for (let i = 0; i < allowedTrackShipment.length; i++) {
      const orderId = allowedTrackShipment[i].order_id;
      const { result, durationMs } = trackShipmentResults[i];
      steps.push({ type: 'tool', toolName: 'track_shipment', orderId, durationMs, outcomeCode: result.ok ? 'OK' : result.error.code });

      if (!result.ok) {
        toolResultFacts.push({ tool: 'track_shipment', orderId, ok: false, code: result.error.code });
        continue;
      }

      const output = result.data as TrackShipmentOutput;
      shipmentFacts.set(orderId, { status: output.status, estimatedDelivery: output.estimatedDelivery });
      toolResultFacts.push({ tool: 'track_shipment', orderId, ok: true, code: 'OK', fields: { status: output.status, carrier: output.carrier } });
    }

    if (pastDeadline()) {
      return await forcedEscalate('DEADLINE_EXCEEDED', undefined);
    }

    // --- 6. Derived facts, computed in code ---
    const derivedFactsForPrompt = {
      orders: [...orderFacts.entries()].map(([orderId, facts]) => ({
        orderId,
        status: facts.status,
        daysSinceDelivery: daysSinceDelivery(facts.deliveredAt, deps.clock),
        remainingRefundableCents: remainingRefundable(facts.totalCents, facts.alreadyRefundedCents),
      })),
      shipments: [...shipmentFacts.entries()].map(([orderId, facts]) => ({
        orderId,
        status: facts.status,
        daysPastEstimate: daysPastEstimate(facts.estimatedDelivery, deps.clock),
      })),
    };

    // --- 7. Compose (LLM call 2) ---
    const composeSystemInstruction = buildSystemInstruction({ phase: 'compose', boundary, identityVerified, allowedTools: [] });
    const composeUserContent = buildComposeUserContent(boundary, input.customerMessage, input.history, retrievedChunks, toolResultFacts, derivedFactsForPrompt);

    const composeOutcome = await callStructured<ComposeOutput>(ComposeOutputSchema, composeSystemInstruction, composeUserContent, 'compose');
    if (composeOutcome.kind === 'llm_error') {
      return await escalateForLlmError(composeOutcome.code, 'COMPOSE_LLM_ERROR');
    }
    if (composeOutcome.kind === 'invalid_output') {
      return await forcedEscalate('INVALID_STRUCTURED_OUTPUT', undefined);
    }
    const compose = composeOutcome.data;

    // --- 8. Citation guard ---
    const guarded = guardCitations(compose.citedChunkKeys, retrievedChunks);
    steps[steps.length - 1] = { ...steps[steps.length - 1], citedChunkKeys: guarded.citations.map((c) => c.chunkKey) };

    // --- 9. Outcome finalization ---
    if (compose.outcome === 'reply') {
      // Stage 4 finding 4 - a `reply` with nothing behind it (no surviving
      // citation, no successful tool result) is an assertion, not an
      // answer. Never passed through - this is a clarify/escalate
      // situation, per PROJECT.md's own "if unsure, clarify or escalate,
      // never guess" guardrail, now enforced in code rather than left to
      // the model to self-police.
      const hasSupport = guarded.citations.length > 0 || toolResultFacts.some((f) => f.ok);
      if (!hasSupport) {
        await callEscalationTool('REPLY_NOT_GROUNDED', undefined);
        logFinal('escalate', { reasonCode: 'REPLY_NOT_GROUNDED' });
        return { result: buildResult('escalate', GENERIC_ESCALATE_MESSAGE, [], undefined), trace: { steps, llmCallCount } };
      }
    }

    if (compose.outcome === 'reply' || compose.outcome === 'clarify') {
      // Stage 4 finding 5 - the model's own message text is still used for
      // these two outcomes, but only after a grounding check: every order
      // id and dollar amount it mentions must be backed by a fact the run
      // actually knows, never trusted at face value.
      const groundingFacts = buildGroundingFacts({
        orderFacts: [...orderFacts.entries()].map(([orderId, facts]) => ({
          orderId,
          totalCents: facts.totalCents,
          alreadyRefundedCents: facts.alreadyRefundedCents,
          remainingRefundableCents: remainingRefundable(facts.totalCents, facts.alreadyRefundedCents),
        })),
        toolResultOrderIds: toolResultFacts.map((f) => f.orderId).filter((id): id is string => id !== undefined),
        retrievedChunkTexts: retrievedChunks.map((c) => c.text),
      });
      const groundingCheck = checkMessageGrounding(compose.message, groundingFacts);
      const message = groundingCheck.grounded ? compose.message : UNGROUNDED_MESSAGE_FALLBACK;
      if (!groundingCheck.grounded) {
        deps.logEvent({
          event: 'agent_message_ungrounded',
          tenantId: input.tenantId,
          runId: input.runId,
          ungroundedOrderIdCount: groundingCheck.ungroundedOrderIdCount,
          ungroundedAmountCount: groundingCheck.ungroundedAmountCount,
        });
      }
      logFinal(compose.outcome);
      return { result: buildResult(compose.outcome, message, guarded.citations, undefined), trace: { steps, llmCallCount } };
    }

    if (compose.outcome === 'escalate') {
      // Stage 4 finding 5 - the customer-facing message for escalate is
      // ALWAYS the one fixed generic string, regardless of what the model
      // wrote - never the model's own free text for this outcome.
      await callEscalationTool('MODEL_REQUESTED_ESCALATION', undefined);
      logFinal('escalate', { reasonCode: 'MODEL_REQUESTED_ESCALATION' });
      return { result: buildResult('escalate', GENERIC_ESCALATE_MESSAGE, guarded.citations, undefined), trace: { steps, llmCallCount } };
    }

    // compose.outcome === 'propose_refund'
    const proposal = compose.proposedRefund!;
    const facts = orderFacts.get(proposal.order_id);
    const validated = facts
      ? validateProposedRefund(proposal, {
          runId: input.runId,
          verifiedOrderIds: ownershipState.verifiedOrderIds,
          orderTotalCents: facts.totalCents,
          alreadyRefundedCents: facts.alreadyRefundedCents,
          reasonCitations: guarded.citations.map((c) => c.chunkKey),
        })
      : { ok: false as const, reason: 'ORDER_NOT_VERIFIED' as const };

    if (validated.ok) {
      // Stage 4 finding 5 - built entirely in code from the VALIDATED
      // action's own order id/amount, never the model's free text, which
      // had said things like "I have submitted a refund proposal" (too
      // close to implying completion) and mentioned irrelevant thresholds.
      const message = buildPendingApprovalMessage(validated.action.args.order_id, validated.action.args.amount);
      logFinal('pending_approval');
      return { result: buildResult('pending_approval', message, guarded.citations, validated.action), trace: { steps, llmCallCount } };
    }

    await callEscalationTool('REFUND_PROPOSAL_REJECTED', proposal.order_id);
    logFinal('escalate', { reasonCode: 'REFUND_PROPOSAL_REJECTED', rejectionReason: validated.reason });
    return { result: buildResult('escalate', GENERIC_ESCALATE_MESSAGE, guarded.citations, undefined), trace: { steps, llmCallCount } };
  } finally {
    clearTimeout(deadlineTimer);
    deps.abortSignal?.removeEventListener('abort', onExternalAbort);
  }
}

async function runToolTimed(
  deps: RunAgentDeps,
  tenantId: string,
  toolName: string,
  args: Record<string, unknown>,
  timeoutMs: number,
): Promise<{ result: ToolRunResult; durationMs: number }> {
  const startedAt = deps.clock().getTime();
  const outcome = await raceTimeout(deps.toolRunner.run(tenantId, toolName, args), timeoutMs);
  const durationMs = deps.clock().getTime() - startedAt;
  if (outcome.timedOut) {
    // Stage 4 finding 6 - a tool call that would otherwise run past the
    // run's own remaining deadline is cut off here, same TIMEOUT code
    // retrieval already uses, fed to compose as an ordinary tool failure.
    return { result: { ok: false, error: { code: 'TIMEOUT', message: 'Tool call exceeded the remaining run deadline.' } }, durationMs };
  }
  return { result: outcome.value, durationMs };
}

async function raceTimeout<T>(promise: Promise<T>, ms: number): Promise<{ timedOut: false; value: T } | { timedOut: true }> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<{ timedOut: true }>((resolve) => {
    timer = setTimeout(() => resolve({ timedOut: true }), ms);
  });
  try {
    const result = await Promise.race([promise.then((value) => ({ timedOut: false as const, value })), timeout]);
    return result;
  } finally {
    clearTimeout(timer!);
  }
}
