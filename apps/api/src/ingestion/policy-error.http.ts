import { HttpException } from '@nestjs/common';
import { PolicyErrorCode } from '@supportpilot/shared';

const STATUS_BY_CODE: Record<PolicyErrorCode, number> = {
  NOT_CONFIGURED: 503,
  INVALID_FILE_TYPE: 422,
  FILE_TOO_LARGE: 413,
  TOO_MANY_FILES: 413,
  INVALID_ENCODING: 422,
  INVALID_CONTENT: 422,
  CHUNK_LIMIT_EXCEEDED: 422,
  DOCUMENT_QUOTA_EXCEEDED: 422,
  CHUNK_QUOTA_EXCEEDED: 422,
  DUPLICATE_CONTENT: 409,
  TENANT_BUSY: 429,
  EMBEDDING_FAILED: 502,
  INGESTION_TIMEOUT: 504,
  COMMIT_FAILED: 500,
  STALE_PENDING_TIMEOUT: 500,
  INTERNAL_ERROR: 500,
};

export function statusForPolicyErrorCode(code: PolicyErrorCode): number {
  return STATUS_BY_CODE[code];
}

export function policyHttpError(code: PolicyErrorCode, message: string, existingDocumentId?: string): HttpException {
  const statusCode = statusForPolicyErrorCode(code);
  return new HttpException({ statusCode, code, message, ...(existingDocumentId ? { existingDocumentId } : {}) }, statusCode);
}
