import { z } from 'zod';
import { idSchema, tenantIdSchema } from './ids';

/**
 * Milestone 4's approval state machine (PROJECT.md's Milestone 4 plan §3).
 * `pending -> approved` is deliberately collapsed into a single atomic
 * `pending -> executing` transition - execution is synchronous within the
 * decision request, so a separate "approved but not yet executing" state
 * would just be an unobservable instant, not a real waiting state worth
 * modeling.
 */
export const APPROVAL_STATUSES = ['pending', 'executing', 'executed', 'failed', 'rejected', 'expired'] as const;
export const ApprovalStatusSchema = z.enum(APPROVAL_STATUSES);
export type ApprovalStatus = z.infer<typeof ApprovalStatusSchema>;

/**
 * The deterministic refund-verifier's own failure vocabulary
 * (apps/api/src/approvals/refund-verifier.ts), shared here so the admin API
 * response and the verifier itself can never drift apart. Checked in this
 * exact order - the first failure wins, both at proposal time and again at
 * decision time against freshly re-fetched order data.
 */
export const VERIFIER_FAILURE_CODES = [
  'ORDER_OWNERSHIP_MISMATCH',
  'INVALID_AMOUNT',
  'ORDER_STATUS_INELIGIBLE',
  'ALREADY_FULLY_REFUNDED',
  'AMOUNT_EXCEEDS_REMAINING_REFUNDABLE',
  'OUTSIDE_REFUND_WINDOW',
  'AMOUNT_EXCEEDS_REFUND_CAP',
  'MISSING_POLICY_CITATION',
  'DAILY_REFUND_COUNT_EXCEEDED',
] as const;
export const VerifierFailureCodeSchema = z.enum(VERIFIER_FAILURE_CODES);
export type VerifierFailureCode = z.infer<typeof VerifierFailureCodeSchema>;

/**
 * Mirrors apps/api/src/agent/tool-runner/tool-runner.ts's own
 * `ToolRunErrorCode` exactly - duplicated here, not imported, because
 * packages/shared sits BELOW apps/api in the dependency graph and can never
 * import from it. Kept honest by a compile-time exhaustiveness guard in
 * apps/api/src/approvals/refund-execution-classification.ts (a `switch`
 * over the real `ToolRunErrorCode` with a `never`-typed default branch) -
 * if that type ever gains a member not listed here, the API package fails
 * to compile, not silently drifts.
 */
export const TOOL_RUN_ERROR_CODES = [
  'INVALID_INPUT',
  'CONFIG_ERROR',
  'SECRET_NOT_CONFIGURED',
  'BLOCKED_BY_POLICY',
  'TIMEOUT',
  'NOT_FOUND',
  'CONFLICT',
  'UPSTREAM_AUTH_FAILED',
  'UPSTREAM_ERROR',
  /** Amendment G1 - a 4xx (400, 422) meaning "this exact request is invalid", distinct from UPSTREAM_ERROR's 5xx/unknown-status bucket. */
  'UPSTREAM_REJECTED',
  'RESPONSE_TOO_LARGE',
  'INVALID_RESPONSE',
] as const;
export const ToolRunErrorCodeSchema = z.enum(TOOL_RUN_ERROR_CODES);

/**
 * What actually happened when execution was attempted: `OK` on a real (or
 * idempotent-replay) success, the raw tool-runner error code on a failed
 * attempt, or - if the decision-time re-check itself failed before any
 * upstream call was ever made - the SAME VerifierFailureCode the
 * proposal-time check would have produced, reused rather than duplicated
 * under a different name.
 */
export const ExecutionResultCodeSchema = z.union([z.literal('OK'), ToolRunErrorCodeSchema, VerifierFailureCodeSchema]);
export type ExecutionResultCode = z.infer<typeof ExecutionResultCodeSchema>;

/**
 * Amendment F4's four-way classification of a failed execution attempt -
 * never derived from the tool-runner code alone at the schema level (see
 * refund-execution-classification.ts for the real logic); just the
 * vocabulary, shared so the admin API and the Approval record can never
 * drift from what the classifier actually produces.
 *
 * - NOT_SENT: confident the refund was never applied (the request never
 *   meaningfully reached the upstream refund operation) - retryable, and
 *   reject is also allowed (either action is safe).
 * - AMBIGUOUS: genuinely unknown whether it was applied - retryable, but
 *   reject is BLOCKED (amendment A) since rejecting would falsely claim
 *   "we decided not to" when it may have already happened.
 * - DEFINITIVE: a clean, explicit "no" from upstream (not found, or a
 *   first-attempt conflict that predates this run entirely) - not
 *   retryable, reject is allowed (there is nothing ambiguous to protect).
 * - NEEDS_RECONCILIATION: a conflict on a RETRY, meaning our own earlier
 *   attempt most likely already succeeded - not retryable by us, reject is
 *   blocked, and this is never surfaced to the customer as a plain
 *   failure; it is flagged for a human to reconcile (Stage 6+ admin work).
 */
export const REFUND_EXECUTION_FAILURE_CLASSES = ['NOT_SENT', 'AMBIGUOUS', 'DEFINITIVE', 'NEEDS_RECONCILIATION'] as const;
export const RefundExecutionFailureClassSchema = z.enum(REFUND_EXECUTION_FAILURE_CLASSES);
export type RefundExecutionFailureClass = z.infer<typeof RefundExecutionFailureClassSchema>;

export const ApprovalDecisionSchema = z.enum(['approve', 'reject']);
export type ApprovalDecision = z.infer<typeof ApprovalDecisionSchema>;

/**
 * POST /v1/approvals/:id/decision's request body. `reasonCode` is a short,
 * free-text-ish note for the audit trail only (e.g. "customer called in") -
 * never shown to the customer, never interpreted by any code path, which is
 * why it's capped short rather than treated as a real message field.
 */
export const ApprovalDecisionRequestSchema = z.object({
  decision: ApprovalDecisionSchema,
  reasonCode: z.string().max(200).optional(),
});
export type ApprovalDecisionRequest = z.infer<typeof ApprovalDecisionRequestSchema>;

/**
 * GET /v1/approvals's query params. `limit` is clamped the same way
 * PolicyRetrievalService clamps `topK` - a request for more is silently
 * capped, never rejected. `status` accepts the computed `expired` value even
 * though a row might still be `pending` in storage (lazily computed, see the
 * Milestone 4 plan §3) - the admin never needs to know which case it is.
 */
export const MAX_APPROVAL_LIST_LIMIT = 100;
export const DEFAULT_APPROVAL_LIST_LIMIT = 20;

export const ApprovalListQuerySchema = z.object({
  status: ApprovalStatusSchema.optional(),
  limit: z.coerce.number().int().positive().max(MAX_APPROVAL_LIST_LIMIT).optional(),
  cursor: z.string().optional(),
});
export type ApprovalListQuery = z.infer<typeof ApprovalListQuerySchema>;

/**
 * The shape returned by every admin-facing approval endpoint - never the
 * raw Mongo document (no internal idempotency key, no Mongo-specific
 * fields). `amount` is decimal dollars, matching every other money field at
 * this project's API boundary (IssueRefundInputSchema.args.amount); the
 * Approval entity itself stores integer cents internally and converts at
 * this exact boundary, the same pattern tool-schemas.ts already uses for
 * GetOrderOutput.
 */
export const ApprovalRecordSchema = z.object({
  id: z.string(),
  tenantId: tenantIdSchema,
  runId: z.string(),
  conversationId: z.string(),
  orderId: idSchema(),
  customerRef: idSchema(),
  amount: z.number(),
  citations: z.array(z.string()),
  status: ApprovalStatusSchema,
  reasonCode: VerifierFailureCodeSchema.optional(),
  executionResultCode: ExecutionResultCodeSchema.optional(),
  failureClass: RefundExecutionFailureClassSchema.optional(),
  /** F4 - whether the refund might actually have been applied upstream, independent of whether WE can retry it. */
  upstreamMaybeReceived: z.boolean().optional(),
  decidedBy: z.string().optional(),
  decidedAt: z.string().optional(),
  expiresAt: z.string(),
  createdAt: z.string(),
});
export type ApprovalRecord = z.infer<typeof ApprovalRecordSchema>;

export const ApprovalListResponseSchema = z.object({
  approvals: z.array(ApprovalRecordSchema),
  nextCursor: z.string().optional(),
});
export type ApprovalListResponse = z.infer<typeof ApprovalListResponseSchema>;
