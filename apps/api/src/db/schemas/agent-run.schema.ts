import { Schema, Types } from 'mongoose';
import { DegradedReasonSchema } from '@supportpilot/shared';

/**
 * Mirrors run-agent.ts's own AgentStepType/ChatOutcomeSchema exactly - kept
 * as a plain literal list here (not imported from agent/loop/run-agent.ts)
 * so this schema file stays self-contained the same way every other schema
 * in this directory only ever imports from 'mongoose' and
 * '@supportpilot/shared', never a sibling feature module. The repository
 * layer (agent-run.repository.ts), not this file, is where the real
 * AgentStepType/AgentTrace types from run-agent.ts are used and mapped.
 */
export const AGENT_STEP_TYPES = ['plan', 'retrieve', 'tool', 'compose', 'repair', 'escalation_tool'] as const;
export const AGENT_RUN_OUTCOMES = ['reply', 'clarify', 'escalate', 'pending_approval'] as const;
/** The same four values ChatResultSchema.degraded accepts (@supportpilot/shared) - kept as a plain array via DegradedReasonSchema.options rather than hand-duplicated, so this can never silently drift from the one the chat response actually sends. */
export const AGENT_RUN_DEGRADED_REASONS = DegradedReasonSchema.options;

export interface AgentStepSubdocument {
  type: (typeof AGENT_STEP_TYPES)[number];
  durationMs: number;
  /** 'OK' on success, otherwise a failure code - never prompt or response text. */
  outcomeCode: string;
  toolName?: string;
  orderId?: string;
  citedChunkKeys?: string[];
  tokenUsage?: { inputTokens: number; outputTokens: number };
  attempts?: number;
}

export interface AgentProposedActionSubdocument {
  tool: string;
  orderId: string;
  amount: number;
}

/**
 * Never stores: prompt text, raw model response text, raw upstream tool
 * response bodies, chunk text, secrets, boundary tokens - only ids, counts,
 * codes, and durations (PROJECT.md's Guardrails/Multi-tenancy sections,
 * Milestone 3 Stage 4 plan §2). `steps` is an embedded sub-document array,
 * not a separate collection - bounded at <=6 (run-agent.ts's own step
 * ceiling), a deliberate, disclosed deviation from PROJECT.md §5's literal
 * separate-collection sketch (avoids 2 more indexes against the M0
 * Search/Vector-index pressure, and a run's trace is always queried as a
 * whole, never filtered by step type across runs). There is deliberately
 * no separate `toolCalls` array: run-agent.ts's own AgentTrace already
 * encodes every tool call inline as a `type: 'tool'` step (toolName,
 * orderId, outcomeCode, durationMs) - a second array would just be a
 * derived duplicate of data already here, drifting the moment one changed
 * without the other.
 */
export interface AgentRunDocument {
  _id: Types.ObjectId;
  tenantId: string;
  /** The Conversation's own _id (an app-generated string, not an ObjectId - see conversation.schema.ts). */
  conversationId: string;
  outcome: (typeof AGENT_RUN_OUTCOMES)[number];
  /** Present only for a 'escalate' outcome caused by an infrastructure condition (quota/circuit-open/model-unavailable), not a model decision - see ChatResultSchema.degraded. */
  degraded: (typeof AGENT_RUN_DEGRADED_REASONS)[number] | null;
  stepCount: number;
  llmCallCount: number;
  tokensIn: number;
  tokensOut: number;
  latencyMs: number;
  steps: AgentStepSubdocument[];
  proposedAction: AgentProposedActionSubdocument | null;
  createdAt: Date;
}

const AgentStepSchema = new Schema<AgentStepSubdocument>(
  {
    type: { type: String, required: true, enum: AGENT_STEP_TYPES },
    durationMs: { type: Number, required: true },
    outcomeCode: { type: String, required: true },
    toolName: { type: String },
    orderId: { type: String },
    citedChunkKeys: { type: [String] },
    tokenUsage: {
      type: new Schema({ inputTokens: Number, outputTokens: Number }, { _id: false }),
    },
    attempts: { type: Number },
  },
  { _id: false },
);

const AgentProposedActionSchema = new Schema<AgentProposedActionSubdocument>(
  {
    tool: { type: String, required: true },
    orderId: { type: String, required: true },
    amount: { type: Number, required: true },
  },
  { _id: false },
);

export const AgentRunSchema = new Schema<AgentRunDocument>(
  {
    tenantId: { type: String, required: true, index: true },
    conversationId: { type: String, required: true },
    outcome: { type: String, required: true, enum: AGENT_RUN_OUTCOMES },
    degraded: { type: String, enum: AGENT_RUN_DEGRADED_REASONS, default: null },
    stepCount: { type: Number, required: true },
    llmCallCount: { type: Number, required: true },
    tokensIn: { type: Number, required: true, default: 0 },
    tokensOut: { type: Number, required: true, default: 0 },
    latencyMs: { type: Number, required: true },
    steps: { type: [AgentStepSchema], required: true, default: [] },
    proposedAction: { type: AgentProposedActionSchema, default: null },
  },
  { collection: 'agentRuns', timestamps: { createdAt: true, updatedAt: false } },
);

AgentRunSchema.index({ tenantId: 1, conversationId: 1 });
AgentRunSchema.index({ tenantId: 1, createdAt: -1 });
