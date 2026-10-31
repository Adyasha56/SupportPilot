import {
  ChatResult,
  ComposeOutput,
  ComposeOutputSchema,
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
import { guardCitations } from './citation-guard';
import { daysPastEstimate, daysSinceDelivery, remainingRefundable } from './derived-facts';
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
  /** Per generate() call - PROJECT.md's Agent loop design, amendment H. */
  perLlmCallTimeoutMs: number;
  /** Total wall-clock budget for the whole run, across every step. */
  totalDeadlineMs: number;
  /** runAgent's own timeout around the retrieval call - PolicyRetrievalService.retrieve() has no timeout of its own. */
  retrievalTimeoutMs: number;
  generateMaxOutputTokens: number;
  generateTemperature: number;
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

export type EscalationReasonCode =
  | 'INVALID_INPUT'
  | 'PLAN_LLM_ERROR'
  | 'COMPOSE_LLM_ERROR'
  | 'INVALID_STRUCTURED_OUTPUT'
  | 'DEADLINE_EXCEEDED'
  | 'MODEL_REQUESTED_ESCALATION'
  | 'REFUND_PROPOSAL_REJECTED';

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
 * call 2) -> citation guard -> outcome finalization. See this file's
 * tests for the full failure matrix.
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

  function buildResult(outcome: ChatResult['outcome'], message: string, citations: ChatResult['citations'], proposedAction: ChatResult['proposedAction']): ChatResult {
    return {
      conversationId: input.conversationId,
      runId: input.runId,
      outcome,
      message,
      citations,
      ...(proposedAction ? { proposedAction } : {}),
    };
  }

  async function forcedEscalate(reasonCode: EscalationReasonCode, orderId: string | undefined): Promise<RunAgentResult> {
    await callEscalationTool(reasonCode, orderId);
    logFinal('escalate', { reasonCode });
    return { result: buildResult('escalate', GENERIC_ESCALATE_MESSAGE, [], undefined), trace: { steps, llmCallCount } };
  }

  // --- 1. Validate input ---
  if (
    typeof input.customerMessage !== 'string' ||
    input.customerMessage.length === 0 ||
    input.customerMessage.length > MAX_CHAT_MESSAGE_LENGTH
  ) {
    return forcedEscalate('INVALID_INPUT', undefined);
  }

  if (pastDeadline()) {
    return forcedEscalate('DEADLINE_EXCEEDED', undefined);
  }

  type StructuredOutcome<T> = { kind: 'ok'; data: T } | { kind: 'llm_error'; code: GenerateErrorCode } | { kind: 'invalid_output' };

  async function callStructured<T>(schema: z.ZodType<T>, systemInstruction: string, userContent: string, stepType: 'plan' | 'compose'): Promise<StructuredOutcome<T>> {
    const responseSchema = toGeminiResponseJsonSchema(schema);

    async function attempt(sysInstr: string) {
      llmCallCount += 1;
      const attemptStartedAt = deps.clock().getTime();
      const outcome = await deps.llmProvider.generate({
        systemInstruction: sysInstr,
        messages: [{ role: 'user', text: userContent }],
        responseSchema,
        maxOutputTokens: deps.settings.generateMaxOutputTokens,
        temperature: deps.settings.generateTemperature,
        timeoutMs: deps.settings.perLlmCallTimeoutMs,
      });
      const durationMs = deps.clock().getTime() - attemptStartedAt;
      return { outcome, durationMs };
    }

    const first = await attempt(systemInstruction);
    if (!first.outcome.ok) {
      steps.push({ type: stepType, durationMs: first.durationMs, outcomeCode: first.outcome.error.code });
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
      steps.push({ type: 'repair', durationMs: repair.durationMs, outcomeCode: repair.outcome.error.code });
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

  // --- 2. Plan (LLM call 1) ---
  const configuredConnectors = deps.connectorConfigRepository.findAllForTenant(input.tenantId);
  const allowed = identityVerified ? allowedPlannerTools(configuredConnectors) : new Set<string>();

  const planSystemInstruction = buildSystemInstruction({ phase: 'plan', boundary, identityVerified, allowedTools: [...allowed] });
  const planUserContent = buildPlanUserContent(boundary, input.customerMessage, input.history);

  const planOutcome = await callStructured<PlannerOutput>(PlannerOutputSchema, planSystemInstruction, planUserContent, 'plan');
  if (planOutcome.kind === 'llm_error') {
    return forcedEscalate('PLAN_LLM_ERROR', undefined);
  }
  if (planOutcome.kind === 'invalid_output') {
    return forcedEscalate('INVALID_STRUCTURED_OUTPUT', undefined);
  }
  const plan = planOutcome.data;

  if (pastDeadline()) {
    return forcedEscalate('DEADLINE_EXCEEDED', undefined);
  }

  // --- 3. Code filters the tool requests ---
  const filteredRequests = plan.toolRequests.filter((request) => allowed.has(request.tool));

  // --- 4. Retrieval, if needsPolicy (own timeout) ---
  let retrievedChunks: RetrievalResult[] = [];
  if (plan.needsPolicy && plan.searchQuery) {
    const retrieveStartedAt = deps.clock().getTime();
    const outcome = await raceTimeout(deps.retrieve(input.tenantId, plan.searchQuery, { topK: deps.settings.retrievalTopK }), deps.settings.retrievalTimeoutMs);
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
  const getOrderResults = await Promise.all(getOrderRequests.map((r) => runToolTimed(deps, input.tenantId, 'get_order', { order_id: r.order_id })));

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

  const trackShipmentResults = await Promise.all(
    allowedTrackShipment.map((r) => runToolTimed(deps, input.tenantId, 'track_shipment', { order_id: r.order_id })),
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
    return forcedEscalate('DEADLINE_EXCEEDED', undefined);
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
    return forcedEscalate('COMPOSE_LLM_ERROR', undefined);
  }
  if (composeOutcome.kind === 'invalid_output') {
    return forcedEscalate('INVALID_STRUCTURED_OUTPUT', undefined);
  }
  const compose = composeOutcome.data;

  // --- 8. Citation guard ---
  const guarded = guardCitations(compose.citedChunkKeys, retrievedChunks);
  steps[steps.length - 1] = { ...steps[steps.length - 1], citedChunkKeys: guarded.citations.map((c) => c.chunkKey) };

  // --- 9. Outcome finalization ---
  if (compose.outcome === 'reply' || compose.outcome === 'clarify') {
    logFinal(compose.outcome);
    return { result: buildResult(compose.outcome, compose.message, guarded.citations, undefined), trace: { steps, llmCallCount } };
  }

  if (compose.outcome === 'escalate') {
    await callEscalationTool('MODEL_REQUESTED_ESCALATION', undefined);
    logFinal('escalate', { reasonCode: 'MODEL_REQUESTED_ESCALATION' });
    return { result: buildResult('escalate', compose.message, guarded.citations, undefined), trace: { steps, llmCallCount } };
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
    logFinal('pending_approval');
    return { result: buildResult('pending_approval', compose.message, guarded.citations, validated.action), trace: { steps, llmCallCount } };
  }

  await callEscalationTool('REFUND_PROPOSAL_REJECTED', proposal.order_id);
  logFinal('escalate', { reasonCode: 'REFUND_PROPOSAL_REJECTED', rejectionReason: validated.reason });
  return { result: buildResult('escalate', GENERIC_ESCALATE_MESSAGE, guarded.citations, undefined), trace: { steps, llmCallCount } };
}

async function runToolTimed(
  deps: RunAgentDeps,
  tenantId: string,
  toolName: string,
  args: Record<string, unknown>,
): Promise<{ result: ToolRunResult; durationMs: number }> {
  const startedAt = deps.clock().getTime();
  const result = await deps.toolRunner.run(tenantId, toolName, args);
  const durationMs = deps.clock().getTime() - startedAt;
  return { result, durationMs };
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
