import { HttpException } from '@nestjs/common';

/**
 * Same one-status-per-code pattern as chat/chat-http-error.ts and
 * ingestion/policy-error.http.ts: one place owns the HTTP status mapping, so
 * ApprovalsController never picks a status ad hoc at the call site. Every
 * non-2xx /v1/approvals* response has exactly this shape:
 * { statusCode, code, message, retryAfterSeconds? }.
 */
export type ApprovalErrorCode =
  | 'NOT_CONFIGURED'
  | 'INVALID_REQUEST'
  | 'RATE_LIMITED'
  /** Decision attempted on an `executing` row still within its lease - amendment B. */
  | 'IN_PROGRESS'
  /** Reject attempted on a failed-AMBIGUOUS or failed-NEEDS_RECONCILIATION row - amendments A/F4. */
  | 'AMBIGUOUS_RETRY_REQUIRED'
  /** Decision attempted on an already-terminal row (executed/rejected/expired). */
  | 'ALREADY_DECIDED'
  | 'EXPIRED'
  /** Stage 6 - the fresh-order fetch itself failed; no state change, safe to retry the decision later. */
  | 'ORDER_FETCH_FAILED'
  | 'INTERNAL_ERROR';

const STATUS_BY_CODE: Record<ApprovalErrorCode, number> = {
  NOT_CONFIGURED: 503,
  INVALID_REQUEST: 400,
  RATE_LIMITED: 429,
  IN_PROGRESS: 409,
  AMBIGUOUS_RETRY_REQUIRED: 409,
  ALREADY_DECIDED: 409,
  EXPIRED: 409,
  ORDER_FETCH_FAILED: 502,
  INTERNAL_ERROR: 500,
};

export function statusForApprovalErrorCode(code: ApprovalErrorCode): number {
  return STATUS_BY_CODE[code];
}

export function approvalHttpError(code: ApprovalErrorCode, message: string, retryAfterSeconds?: number): HttpException {
  const statusCode = statusForApprovalErrorCode(code);
  return new HttpException({ statusCode, code, message, ...(retryAfterSeconds !== undefined ? { retryAfterSeconds } : {}) }, statusCode);
}
