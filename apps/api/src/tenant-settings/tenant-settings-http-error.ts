import { HttpException } from '@nestjs/common';

/**
 * Stage 1c, item 3 - `GET`/`PUT /v1/tenant/settings`. Same
 * one-status-per-code pattern as approvals/approval-http-error.ts and
 * ingestion/policy-error.http.ts.
 */
export type TenantSettingsErrorCode =
  | 'NOT_CONFIGURED'
  | 'INVALID_REQUEST'
  /** An admin API-key principal attempted to touch refundCap or autoExecuteRefunds at all - never allowed, regardless of direction or value. */
  | 'KEY_PRINCIPAL_CANNOT_CHANGE_FIELD'
  /** This call would raise refundCap or enable autoExecuteRefunds but carried no `password` field. */
  | 'STEP_UP_REQUIRED'
  /** `password` was present but did not verify - counted toward the credential's own lockout, same as a wrong login password. */
  | 'INVALID_PASSWORD'
  /** autoExecuteRefunds: true was requested without confirmAutoExecute: true in the same call. */
  | 'CONFIRMATION_REQUIRED'
  | 'VALIDATION_FAILED'
  | 'TENANT_NOT_FOUND'
  /** The step-up hash queue is full - try again shortly, never silently treated as a wrong password. */
  | 'HASH_QUEUE_FULL';

const STATUS_BY_CODE: Record<TenantSettingsErrorCode, number> = {
  NOT_CONFIGURED: 503,
  INVALID_REQUEST: 400,
  KEY_PRINCIPAL_CANNOT_CHANGE_FIELD: 403,
  STEP_UP_REQUIRED: 400,
  INVALID_PASSWORD: 401,
  CONFIRMATION_REQUIRED: 400,
  VALIDATION_FAILED: 422,
  TENANT_NOT_FOUND: 404,
  HASH_QUEUE_FULL: 503,
};

export function tenantSettingsHttpError(code: TenantSettingsErrorCode, message: string): HttpException {
  const statusCode = STATUS_BY_CODE[code];
  return new HttpException({ statusCode, code, message }, statusCode);
}
