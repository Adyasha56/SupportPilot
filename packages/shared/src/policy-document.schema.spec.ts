import { describe, expect, it } from 'vitest';
import { PolicyDocumentSummarySchema, PolicyErrorResponseSchema, POLICY_ERROR_CODES, POLICY_FAILURE_CODES } from './policy-document.schema';

describe('PolicyDocumentSummarySchema', () => {
  it('accepts a valid summary with a null failureCode', () => {
    const result = PolicyDocumentSummarySchema.safeParse({
      id: 'd1',
      title: 'Refund Policy',
      status: 'ready',
      failureCode: null,
      uploadedAt: new Date().toISOString(),
      chunkCount: 5,
    });
    expect(result.success).toBe(true);
  });

  it('rejects an unknown status', () => {
    const result = PolicyDocumentSummarySchema.safeParse({
      id: 'd1',
      title: 'x',
      status: 'processing',
      failureCode: null,
      uploadedAt: new Date().toISOString(),
      chunkCount: 0,
    });
    expect(result.success).toBe(false);
  });
});

describe('PolicyErrorResponseSchema', () => {
  it('every POLICY_FAILURE_CODES value is also a valid POLICY_ERROR_CODES value', () => {
    for (const code of POLICY_FAILURE_CODES) {
      expect(POLICY_ERROR_CODES).toContain(code);
    }
  });

  it('accepts an optional existingDocumentId (for 409 duplicates)', () => {
    const result = PolicyErrorResponseSchema.safeParse({
      statusCode: 409,
      code: 'DUPLICATE_CONTENT',
      message: 'Already uploaded',
      existingDocumentId: 'd1',
    });
    expect(result.success).toBe(true);
  });
});
