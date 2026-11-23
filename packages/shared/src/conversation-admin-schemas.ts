import { z } from 'zod';
import { ChatOutcomeSchema, DegradedReasonSchema } from './agent-schemas';
import { VerifierFailureCodeSchema } from './approval-schemas';

/**
 * Milestone 5, Stage 1c, item 2 - the admin console's conversation list and
 * detail views (`GET /v1/conversations`, `GET /v1/conversations/:id`).
 *
 * `AGENT_STEP_TYPES`/`REFUND_DISPOSITION_KINDS` deliberately MIRROR, rather
 * than import, `apps/api/src/db/schemas/agent-run.schema.ts`'s own
 * identically-named constants - packages/shared sits BELOW apps/api in the
 * dependency graph and can never import from it (the same reason
 * approval-schemas.ts duplicates `TOOL_RUN_ERROR_CODES` instead of
 * importing the API's own `ToolRunErrorCode`). `ChatOutcomeSchema` and
 * `DegradedReasonSchema` are NOT duplicated here, since both already live
 * in this package (agent-schemas.ts) and `AGENT_RUN_OUTCOMES`/
 * `AGENT_RUN_DEGRADED_REASONS` on the API side are already derived from
 * them, not independent copies.
 */
export const AGENT_STEP_TYPES = ['plan', 'retrieve', 'tool', 'compose', 'repair', 'escalation_tool'] as const;
export const AgentStepTypeSchema = z.enum(AGENT_STEP_TYPES);
export type AgentStepType = z.infer<typeof AgentStepTypeSchema>;

export const REFUND_DISPOSITION_KINDS = ['denied', 'pending_approval', 'auto_executed', 'already_pending'] as const;
export const RefundDispositionKindSchema = z.enum(REFUND_DISPOSITION_KINDS);
export type RefundDispositionKind = z.infer<typeof RefundDispositionKindSchema>;

/**
 * A step's citations, resolved to `headingPath`/`documentTitle` at READ
 * time (ConversationsAdminService), never stored that way - the AgentRun's
 * own `citedChunkKeys` stays exactly as run-agent.ts already writes it
 * (plain keys, Milestone 3's existing contract, left untouched by this
 * stage). `headingPath`/`documentTitle` are optional because the admin
 * view does a best-effort lookup against the CURRENT PolicyChunk
 * collection - a policy document deleted since the run happened means the
 * key no longer resolves to anything, and the admin still sees the bare
 * key rather than a broken response.
 */
export const AdminCitationSchema = z.object({
  chunkKey: z.string(),
  headingPath: z.string().optional(),
  documentTitle: z.string().optional(),
});
export type AdminCitation = z.infer<typeof AdminCitationSchema>;

/**
 * Never prompt text, raw model output, or raw tool response bodies -
 * exactly the same fields `AgentStepSubdocument` already stores (ids,
 * codes, counts, durations only). This schema is a 1:1 shape match with
 * that document's own fields, plus `citations` resolved from its raw
 * `citedChunkKeys` as described above.
 */
export const AdminAgentStepSchema = z.object({
  type: AgentStepTypeSchema,
  durationMs: z.number(),
  outcomeCode: z.string(),
  toolName: z.string().optional(),
  orderId: z.string().optional(),
  citations: z.array(AdminCitationSchema).optional(),
  tokenUsage: z.object({ inputTokens: z.number(), outputTokens: z.number() }).optional(),
  attempts: z.number().optional(),
});
export type AdminAgentStep = z.infer<typeof AdminAgentStepSchema>;

export const AdminRefundDispositionSchema = z.object({
  kind: RefundDispositionKindSchema,
  failedRuleCodes: z.array(VerifierFailureCodeSchema).optional(),
  approvalId: z.string().optional(),
});
export type AdminRefundDisposition = z.infer<typeof AdminRefundDispositionSchema>;

/** A proposal SUMMARY, never an execution record - `amount` in decimal dollars, the same API-boundary convention every other money field in this project uses. */
export const AdminProposedActionSchema = z.object({
  tool: z.string(),
  orderId: z.string(),
  amount: z.number(),
});
export type AdminProposedAction = z.infer<typeof AdminProposedActionSchema>;

export const AdminAgentRunSchema = z.object({
  id: z.string(),
  runId: z.string(),
  outcome: ChatOutcomeSchema,
  degraded: DegradedReasonSchema.optional(),
  stepCount: z.number(),
  llmCallCount: z.number(),
  tokensIn: z.number(),
  tokensOut: z.number(),
  latencyMs: z.number(),
  steps: z.array(AdminAgentStepSchema),
  proposedAction: AdminProposedActionSchema.optional(),
  refundDisposition: AdminRefundDispositionSchema.optional(),
  createdAt: z.string(),
});
export type AdminAgentRun = z.infer<typeof AdminAgentRunSchema>;

export const AdminConversationMessageSchema = z.object({
  role: z.enum(['customer', 'agent']),
  content: z.string(),
  createdAt: z.string(),
});
export type AdminConversationMessage = z.infer<typeof AdminConversationMessageSchema>;

export const ConversationStatusSchema = z.enum(['open', 'closed']);
export type ConversationStatusValue = z.infer<typeof ConversationStatusSchema>;

/**
 * `customerRef` is shown in FULL here (never redacted/truncated) - this is
 * the admin console, not a customer-facing or logged surface; the "never
 * in a log line" rule applies to server-side logging, never to this
 * response (PROJECT.md's Milestone 5 handoff section, item 2).
 */
export const ConversationSummarySchema = z.object({
  id: z.string(),
  customerRef: z.string().nullable(),
  status: ConversationStatusSchema,
  messageCount: z.number(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type ConversationSummary = z.infer<typeof ConversationSummarySchema>;

export const MAX_CONVERSATION_LIST_LIMIT = 100;
export const DEFAULT_CONVERSATION_LIST_LIMIT = 20;

/**
 * `cursor` is opaque (same discipline as ApprovalListQuerySchema's own
 * `cursor`) - only the repository's own encode/decode functions know its
 * shape. `createdAfter`/`createdBefore` are full ISO-8601 timestamps, both
 * optional and independently usable (an admin can filter "since" without
 * an upper bound, or vice versa).
 */
export const ConversationListQuerySchema = z.object({
  status: ConversationStatusSchema.optional(),
  createdAfter: z.string().datetime().optional(),
  createdBefore: z.string().datetime().optional(),
  limit: z.coerce.number().int().positive().max(MAX_CONVERSATION_LIST_LIMIT).optional(),
  cursor: z.string().optional(),
});
export type ConversationListQuery = z.infer<typeof ConversationListQuerySchema>;

export const ConversationListResponseSchema = z.object({
  conversations: z.array(ConversationSummarySchema),
  nextCursor: z.string().optional(),
});
export type ConversationListResponse = z.infer<typeof ConversationListResponseSchema>;

export const ConversationDetailResponseSchema = z.object({
  id: z.string(),
  customerRef: z.string().nullable(),
  status: ConversationStatusSchema,
  messageCount: z.number(),
  createdAt: z.string(),
  updatedAt: z.string(),
  messages: z.array(AdminConversationMessageSchema),
  runs: z.array(AdminAgentRunSchema),
});
export type ConversationDetailResponse = z.infer<typeof ConversationDetailResponseSchema>;
