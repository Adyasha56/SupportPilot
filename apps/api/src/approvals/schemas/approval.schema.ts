import { Schema, Types } from 'mongoose';
import {
  ApprovalStatusSchema,
  EXECUTION_FAILURE_CODES,
  ExecutionResultCode,
  VERIFIER_FAILURE_CODES,
  VerifierFailureCode,
} from '@supportpilot/shared';

/**
 * Mirrors packages/shared/src/approval-schemas.ts's own enums exactly -
 * kept as plain literal arrays here (not imported as mongoose enum values
 * directly from the zod schema) the same way agent-run.schema.ts already
 * does for AGENT_RUN_OUTCOMES/AGENT_RUN_DEGRADED_REASONS: this file stays
 * self-contained (mongoose + @supportpilot/shared only), and the repository
 * layer (approval.repository.ts) is where the real RefundVerifierOutput/
 * RuleVerdict types from refund-verifier.ts are used and mapped.
 */
export const APPROVAL_STATUSES = ApprovalStatusSchema.options;
export type ApprovalStatusValue = (typeof APPROVAL_STATUSES)[number];

/** 'OK' plus every upstream-failure code plus every verifier-failure code (a decision-time re-check failure reuses those same codes) - see ExecutionResultCodeSchema's own doc comment for why these are reused rather than duplicated under new names. */
export const EXECUTION_RESULT_CODE_VALUES = ['OK', ...EXECUTION_FAILURE_CODES, ...VERIFIER_FAILURE_CODES] as const;

export interface RuleVerdictSubdocument {
  code: VerifierFailureCode;
  passed: boolean;
}

const RuleVerdictSchema = new Schema<RuleVerdictSubdocument>(
  {
    code: { type: String, required: true, enum: VERIFIER_FAILURE_CODES },
    passed: { type: Boolean, required: true },
  },
  { _id: false },
);

/**
 * No free-text fields anywhere (Stage 3 instruction, restated here as the
 * one rule every field below must satisfy): every string field is either
 * an id (tenantId/runId/conversationId/orderId/customerRef/idempotencyKey,
 * all already validated elsewhere before an Approval is ever created) or a
 * validated enum (status/reasonCode/executionResultCode/the rule verdict
 * codes). `decidedBy` is an id too - either a real apiKeyId or the fixed
 * literal "system:auto_execute", never admin-entered text (amendment I's
 * own adminReasonCode enum is Stage 6 work, once the decision endpoint
 * that actually needs it exists - not added here as unused schema surface
 * ahead of that).
 */
export interface ApprovalDocument {
  _id: Types.ObjectId;
  tenantId: string;
  runId: string;
  conversationId: string;
  orderId: string;
  customerRef: string;
  amountCents: number;
  citations: string[];
  status: ApprovalStatusValue;
  /** Only meaningful when status === 'failed' (amendment A) - null otherwise, never a stray true/false. */
  retryable: boolean | null;
  /** True for pending/executing/failed-retryable; false for every terminal state (amendment C). */
  active: boolean;
  verifierVerdictAtProposal: RuleVerdictSubdocument[];
  /** Populated only after the first decision-time re-check has actually run (amendment A/I) - null until then. */
  verifierVerdictAtDecision: RuleVerdictSubdocument[] | null;
  /** Derived from _id, written in the SAME insert as _id - amendment G, never a follow-up write. */
  idempotencyKey: string;
  attemptCount: number;
  /** Set once, on the very first execution attempt only - never updated again. */
  executionStartedAt: Date | null;
  /** Set (and refreshed) every time the row enters/re-enters 'executing' - the lease amendment B reads. */
  executingSince: Date | null;
  decidedBy: string | null;
  decidedAt: Date | null;
  reasonCode: VerifierFailureCode | null;
  executionResultCode: ExecutionResultCode | null;
  expiresAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

const ApprovalSchema = new Schema<ApprovalDocument>(
  {
    tenantId: { type: String, required: true },
    runId: { type: String, required: true },
    conversationId: { type: String, required: true },
    orderId: { type: String, required: true },
    customerRef: { type: String, required: true },
    amountCents: { type: Number, required: true },
    citations: { type: [String], required: true, default: [] },
    status: { type: String, required: true, enum: APPROVAL_STATUSES },
    retryable: { type: Boolean, default: null },
    active: { type: Boolean, required: true },
    verifierVerdictAtProposal: { type: [RuleVerdictSchema], required: true, default: [] },
    verifierVerdictAtDecision: { type: [RuleVerdictSchema], default: null },
    idempotencyKey: { type: String, required: true },
    attemptCount: { type: Number, required: true, default: 0 },
    executionStartedAt: { type: Date, default: null },
    executingSince: { type: Date, default: null },
    decidedBy: { type: String, default: null },
    decidedAt: { type: Date, default: null },
    reasonCode: { type: String, enum: VERIFIER_FAILURE_CODES, default: null },
    executionResultCode: { type: String, enum: EXECUTION_RESULT_CODE_VALUES, default: null },
    expiresAt: { type: Date, required: true },
  },
  { collection: 'approvals', timestamps: { createdAt: true, updatedAt: true } },
);

ApprovalSchema.index({ tenantId: 1, status: 1, createdAt: -1 });
ApprovalSchema.index({ tenantId: 1, conversationId: 1 });
ApprovalSchema.index({ tenantId: 1, customerRef: 1, createdAt: -1 });

/**
 * Amendment C's authoritative guarantee: at most one row per
 * (tenantId, orderId) while active is true. Given an explicit, stable name
 * so db-ensure-indexes.ts can identify it by name across runs regardless
 * of mongoose's own auto-naming, and so a genuine options mismatch (unique
 * flag or partialFilterExpression changed) can be flagged as an error to
 * resolve manually - exactly like the PolicyChunk vector index's own
 * definitionsMatch check - rather than ever auto-applied via an
 * unprotected drop-and-recreate on live data.
 */
export const APPROVAL_ACTIVE_ORDER_UNIQUE_INDEX_NAME = 'approval_active_order_unique';
ApprovalSchema.index(
  { tenantId: 1, orderId: 1 },
  { unique: true, partialFilterExpression: { active: true }, name: APPROVAL_ACTIVE_ORDER_UNIQUE_INDEX_NAME },
);

/**
 * TTL (createdAt, APPROVAL_RETENTION_DAYS) is deliberately NOT declared
 * here via schema.index() - same rule Message/AgentRun/Conversation
 * already follow (see db-ensure-indexes.ts's own module doc comment for
 * why mixing a schema-declared TTL into the generic diffIndexes() path
 * caused a real bug). It is created and kept in sync purely by
 * db-ensure-indexes.ts's own ttl config for this collection.
 */
export { ApprovalSchema };
