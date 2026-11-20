import { HttpException } from '@nestjs/common';
import { ConversationMessagesErrorCode } from './conversation-messages.service';

/** Same one-status-per-code pattern as chat-http-error.ts - one place owns the HTTP status mapping. */
const STATUS_BY_CODE: Record<ConversationMessagesErrorCode, number> = {
  NOT_CONFIGURED: 503,
  INVALID_REQUEST: 400,
  INVALID_CUSTOMER_TOKEN: 401,
  RATE_LIMITED: 429,
  NOT_FOUND: 404,
};

export function conversationMessagesHttpError(code: ConversationMessagesErrorCode, message: string, retryAfterSeconds?: number): HttpException {
  const statusCode = STATUS_BY_CODE[code];
  return new HttpException({ statusCode, code, message, ...(retryAfterSeconds !== undefined ? { retryAfterSeconds } : {}) }, statusCode);
}
