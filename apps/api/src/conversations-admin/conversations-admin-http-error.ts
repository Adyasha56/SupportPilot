import { HttpException } from '@nestjs/common';

/**
 * Stage 1c, item 2 - `GET /v1/conversations`, `GET /v1/conversations/:id`.
 * Same one-status-per-code pattern as approvals/approval-http-error.ts:
 * one place owns the HTTP status mapping. A nonexistent id and another
 * tenant's id are never distinguished - the controller throws a plain
 * `NotFoundException()` (Nest's own default body) for both, the same
 * "identical 404" rule PoliciesController/ApprovalsController already
 * follow, rather than routing that case through this code table at all.
 */
export type ConversationsAdminErrorCode = 'NOT_CONFIGURED' | 'INVALID_REQUEST';

const STATUS_BY_CODE: Record<ConversationsAdminErrorCode, number> = {
  NOT_CONFIGURED: 503,
  INVALID_REQUEST: 400,
};

export function conversationsAdminHttpError(code: ConversationsAdminErrorCode, message: string): HttpException {
  const statusCode = STATUS_BY_CODE[code];
  return new HttpException({ statusCode, code, message }, statusCode);
}
