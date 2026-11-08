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
 * What actually happened when execution was attempted: `OK` on a real (or
 * idempotent-replay) success, one of the upstream-call outcomes, or - if the
 * decision-time re-check itself failed before any upstream call was ever
 * made - the SAME VerifierFailureCode the proposal-time check would have
 * produced, reused rather than duplicated under a different name.
 */
export const EXECUTION_FAILURE_CODES = ['UPSTREAM_UNAVAILABLE', 'UPSTREAM_TIMEOUT', 'ALREADY_REFUNDED_UPSTREAM'] as const;
export const ExecutionResultCodeSchema = z.union([z.literal('OK'), z.enum(EXECUTION_FAILURE_CODES), VerifierFailureCodeSchema]);
export type ExecutionResultCode = z.infer<typeof ExecutionResultCodeSchema>;

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
