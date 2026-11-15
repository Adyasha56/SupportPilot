import { Schema, Types } from 'mongoose';
import { DegradedReasonSchema, VERIFIER_FAILURE_CODES, VerifierFailureCode } from '@supportpilot/shared';

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
 * Milestone 4 amendment D - the refund-verifier's immediate disposition for
 * this run's proposal (if any), written ONCE at AgentRun creation time, in
 * the same transaction as the Approval row it may also create, and NEVER
 * updated afterward: AgentRun stays exactly as immutable as every other
 * field already is. Milestone 6's eval harness reads this directly for the
 * immediate outcome (denied/already_pending/auto_executed/pending_approval)
 * and only follows `approvalId` to the Approval record for the LATER
 * human-decision outcome of a pending_approval case.
 */
export const REFUND_DISPOSITION_KINDS = ['denied', 'pending_approval', 'auto_executed', 'already_pending'] as const;

export interface RefundDispositionSubdocument {
  kind: (typeof REFUND_DISPOSITION_KINDS)[number];
  /** Only present for kind: 'denied' - every rule that failed, in fixed order (amendment F). */
  failedRuleCodes?: VerifierFailureCode[];
  /** Present for every kind except 'denied' - the Approval row this disposition refers to. */
  approvalId?: string;
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
  /**
   * Stage 5 follow-up I1(b) - the SAME runId chat.service.ts generates per
   * request (run-id.ts's generateRunId()) and already returns to the
   * customer as ChatResult.runId; now also stored here so a run's own
   * AgentRun write is idempotent (see the unique index below). Required
   * going forward, but NOT backfilled onto historical documents created
   * before this field existed - see the sparse index's own doc comment for
   * why that's safe.
   */
  runId: string;
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
  refundDisposition: RefundDispositionSubdocument | null;
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

const RefundDispositionSchema = new Schema<RefundDispositionSubdocument>(
  {
    kind: { type: String, required: true, enum: REFUND_DISPOSITION_KINDS },
    failedRuleCodes: { type: [String], enum: VERIFIER_FAILURE_CODES },
    approvalId: { type: String },
  },
  { _id: false },
);

export const AgentRunSchema = new Schema<AgentRunDocument>(
  {
    tenantId: { type: String, required: true, index: true },
    // required at the schema level for every NEW document - deliberately not backfilled onto
    // historical documents (see the sparse unique index below), since Mongoose's own `required`
    // only governs writes made through it, never retroactively validates existing data.
    runId: { type: String, required: true },
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
    refundDisposition: { type: RefundDispositionSchema, default: null },
  },
  { collection: 'agentRuns', timestamps: { createdAt: true, updatedAt: false } },
);

AgentRunSchema.index({ tenantId: 1, conversationId: 1 });
AgentRunSchema.index({ tenantId: 1, createdAt: -1 });

/**
 * Stage 5 follow-up I1(b) - one AgentRun document per run, period; a
 * retry that re-attempts the same run's insert (because the first
 * attempt's own result was ambiguous) hits this index and the repository
 * reads back the already-committed document instead of creating a
 * second one - this is what makes `ApprovalService.createFromProposal`'s
 * persistence retry safe to re-run from scratch.
 *
 * SPARSE, unlike Approval's own `{tenantId, runId}` unique index
 * (approval.schema.ts) - `runId` did not exist on this schema until this
 * change, so any document created before it would have no value for the
 * field at all (not even `null` - the key is simply absent). A sparse
 * index never indexes a document missing the field, so any number of
 * historical documents can coexist safely; uniqueness is enforced only
 * among documents that DO have a `runId`, which is every document from
 * this point forward (the field is `required` above). db-ensure-indexes.ts's
 * own pre-check (`checkNoDuplicateRunIds`) still refuses to create this if
 * two documents already share a `runId` - a sparse index does not protect
 * against that, only against a MISSING field colliding with another
 * missing field.
 */
export const AGENT_RUN_RUN_UNIQUE_INDEX_NAME = 'agent_run_run_unique';
AgentRunSchema.index({ tenantId: 1, runId: 1 }, { unique: true, sparse: true, name: AGENT_RUN_RUN_UNIQUE_INDEX_NAME });
