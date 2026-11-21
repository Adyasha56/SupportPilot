import { HttpException } from '@nestjs/common';

export type AdminAuthErrorCode = 'INVALID_REQUEST' | 'INVALID_CREDENTIALS' | 'RATE_LIMITED' | 'HASH_QUEUE_FULL' | 'NOT_CONFIGURED';

const STATUS_BY_CODE: Record<AdminAuthErrorCode, number> = {
  INVALID_REQUEST: 400,
  INVALID_CREDENTIALS: 401,
  RATE_LIMITED: 429,
  HASH_QUEUE_FULL: 429,
  NOT_CONFIGURED: 503,
};

export function adminAuthHttpError(code: AdminAuthErrorCode, message: string, retryAfterSeconds?: number): HttpException {
  const statusCode = STATUS_BY_CODE[code];
  return new HttpException({ statusCode, code, message, ...(retryAfterSeconds !== undefined ? { retryAfterSeconds } : {}) }, statusCode);
}
