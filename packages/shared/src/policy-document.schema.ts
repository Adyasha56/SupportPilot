import { z } from 'zod';

export const POLICY_DOCUMENT_STATUSES = ['pending', 'ready', 'failed'] as const;
export const PolicyDocumentStatusSchema = z.enum(POLICY_DOCUMENT_STATUSES);
export type PolicyDocumentStatus = z.infer<typeof PolicyDocumentStatusSchema>;

/**
 * Codes a document's OWN `failureCode` can end up holding once it has been
 * created as `pending` - i.e. failures that happen mid-pipeline, after
 * request-level validation already passed. Never includes request-level
 * rejection codes (bad extension, duplicate content, etc.) below, because
 * those are rejected before a document row is ever created.
 */
export const POLICY_FAILURE_CODES = [
  'EMBEDDING_FAILED',
  'INGESTION_TIMEOUT',
  'COMMIT_FAILED',
  'STALE_PENDING_TIMEOUT',
  'INTERNAL_ERROR',
] as const;
export const PolicyFailureCodeSchema = z.enum(POLICY_FAILURE_CODES);
export type PolicyFailureCode = z.infer<typeof PolicyFailureCodeSchema>;

/** The full set of codes a POST /v1/policies error response can carry - request-level rejections plus every PolicyFailureCode. */
export const POLICY_ERROR_CODES = [
  'NOT_CONFIGURED',
  'INVALID_FILE_TYPE',
  'FILE_TOO_LARGE',
  'TOO_MANY_FILES',
  'INVALID_ENCODING',
  'INVALID_CONTENT',
  'CHUNK_LIMIT_EXCEEDED',
  'DOCUMENT_QUOTA_EXCEEDED',
  'CHUNK_QUOTA_EXCEEDED',
  'DUPLICATE_CONTENT',
  'TENANT_BUSY',
  ...POLICY_FAILURE_CODES,
] as const;
export const PolicyErrorCodeSchema = z.enum(POLICY_ERROR_CODES);
export type PolicyErrorCode = z.infer<typeof PolicyErrorCodeSchema>;

/** Never includes text or embeddings - a document's content is write-only from the API's perspective. */
export const PolicyDocumentSummarySchema = z.object({
  id: z.string(),
  title: z.string(),
  status: PolicyDocumentStatusSchema,
  failureCode: PolicyFailureCodeSchema.nullable(),
  uploadedAt: z.string(),
  chunkCount: z.number().int().nonnegative(),
});
export type PolicyDocumentSummary = z.infer<typeof PolicyDocumentSummarySchema>;

export const PolicyDocumentListResponseSchema = z.array(PolicyDocumentSummarySchema);

export const PolicyErrorResponseSchema = z.object({
  statusCode: z.number().int(),
  code: PolicyErrorCodeSchema,
  message: z.string(),
  /** Only present on a 409 DUPLICATE_CONTENT response. */
  existingDocumentId: z.string().optional(),
});
export type PolicyErrorResponse = z.infer<typeof PolicyErrorResponseSchema>;
