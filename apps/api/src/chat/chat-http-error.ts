import { HttpException } from '@nestjs/common';

/**
 * Same one-status-per-code pattern as ingestion/policy-error.http.ts: one
 * place owns the HTTP status mapping, so chat.service.ts and
 * chat.controller.ts never pick a status ad hoc at the call site. Every
 * non-2xx /v1/chat response has exactly this shape:
 * { statusCode, code, message, retryAfterSeconds? }.
 */
export type ChatErrorCode =
  | 'INVALID_REQUEST'
  | 'REQUEST_TOO_LARGE'
  /** Stage 4 amendment A - a customer token that is PRESENT but fails verification for ANY reason. Never collapsed into anonymous. */
  | 'INVALID_CUSTOMER_TOKEN'
  | 'NOT_CONFIGURED'
  /** The tenant/customerRef layers (chat.service.ts) - distinct from ApiKeyGuard's own IP/key 429, which that guard throws itself with the identical shape. */
  | 'RATE_LIMITED'
  /** Stage 4 amendment B - the global in-flight-run cap, a capacity ceiling rather than a request-rate violation. */
  | 'BACKPRESSURE'
  /** A second request for the same conversation arrived while the first was still being processed. */
  | 'CONVERSATION_BUSY'
  | 'CONVERSATION_LENGTH_EXCEEDED'
  /** Stage 4 amendment C - a pending_approval result's AgentRun write failed even after one retry; the proposal is never returned at all. */
  | 'PENDING_APPROVAL_WRITE_FAILED'
  /** Defense-in-depth HTTP-level deadline (ChatSettings.httpDeadlineMs) fired - should be unreachable in practice, since runAgent's own AbortController guarantees termination well before this. */
  | 'REQUEST_TIMEOUT'
  | 'INTERNAL_ERROR';

const STATUS_BY_CODE: Record<ChatErrorCode, number> = {
  INVALID_REQUEST: 400,
  REQUEST_TOO_LARGE: 413,
  INVALID_CUSTOMER_TOKEN: 401,
  NOT_CONFIGURED: 503,
  RATE_LIMITED: 429,
  BACKPRESSURE: 429,
  CONVERSATION_BUSY: 409,
  CONVERSATION_LENGTH_EXCEEDED: 409,
  PENDING_APPROVAL_WRITE_FAILED: 503,
  REQUEST_TIMEOUT: 503,
  INTERNAL_ERROR: 500,
};

export function statusForChatErrorCode(code: ChatErrorCode): number {
  return STATUS_BY_CODE[code];
}

export function chatHttpError(code: ChatErrorCode, message: string, retryAfterSeconds?: number): HttpException {
  const statusCode = statusForChatErrorCode(code);
  return new HttpException({ statusCode, code, message, ...(retryAfterSeconds !== undefined ? { retryAfterSeconds } : {}) }, statusCode);
}
