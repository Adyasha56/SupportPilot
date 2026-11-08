import { describe, expect, it } from 'vitest';
import {
  ApprovalDecisionRequestSchema,
  ApprovalListQuerySchema,
  ApprovalRecordSchema,
  EXECUTION_FAILURE_CODES,
  ExecutionResultCodeSchema,
  MAX_APPROVAL_LIST_LIMIT,
  VERIFIER_FAILURE_CODES,
  VerifierFailureCodeSchema,
} from './approval-schemas';

function approvalRecord(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'apr_1',
    tenantId: 'acme',
    runId: 'run_1',
    conversationId: 'conv_1',
    orderId: 'ORD-1001',
    customerRef: 'cust_1',
    amount: 49.99,
    citations: ['d1-0'],
    status: 'pending',
    expiresAt: '2026-11-15T00:00:00.000Z',
    createdAt: '2026-11-08T00:00:00.000Z',
    ...overrides,
  };
}

describe('ApprovalRecordSchema', () => {
  it('accepts a minimal pending record', () => {
    expect(ApprovalRecordSchema.safeParse(approvalRecord()).success).toBe(true);
  });

  it('accepts a decided record with reasonCode/executionResultCode/decidedBy/decidedAt', () => {
    const result = ApprovalRecordSchema.safeParse(
      approvalRecord({
        status: 'executed',
        reasonCode: undefined,
        executionResultCode: 'OK',
        decidedBy: 'key_123',
        decidedAt: '2026-11-08T01:00:00.000Z',
      }),
    );
    expect(result.success).toBe(true);
  });

  it('rejects an unknown status', () => {
    expect(ApprovalRecordSchema.safeParse(approvalRecord({ status: 'done' })).success).toBe(false);
  });

  it('has no field for the internal idempotency key', () => {
    expect(Object.keys(ApprovalRecordSchema.shape)).not.toContain('idempotencyKey');
  });
});

describe('ExecutionResultCodeSchema', () => {
  it('accepts OK', () => {
    expect(ExecutionResultCodeSchema.safeParse('OK').success).toBe(true);
  });

  it.each(EXECUTION_FAILURE_CODES)('accepts upstream failure code %s', (code) => {
    expect(ExecutionResultCodeSchema.safeParse(code).success).toBe(true);
  });

  it.each(VERIFIER_FAILURE_CODES)('accepts a reused verifier failure code %s (decision-time re-check failed)', (code) => {
    expect(ExecutionResultCodeSchema.safeParse(code).success).toBe(true);
  });

  it('rejects an unrelated string', () => {
    expect(ExecutionResultCodeSchema.safeParse('SOMETHING_ELSE').success).toBe(false);
  });
});

describe('VerifierFailureCodeSchema', () => {
  it('accepts every documented failure code', () => {
    for (const code of VERIFIER_FAILURE_CODES) {
      expect(VerifierFailureCodeSchema.safeParse(code).success).toBe(true);
    }
  });
});

describe('ApprovalDecisionRequestSchema', () => {
  it('accepts approve/reject with an optional reasonCode', () => {
    expect(ApprovalDecisionRequestSchema.safeParse({ decision: 'approve' }).success).toBe(true);
    expect(ApprovalDecisionRequestSchema.safeParse({ decision: 'reject', reasonCode: 'policy mismatch' }).success).toBe(true);
  });

  it('rejects a decision outside approve/reject', () => {
    expect(ApprovalDecisionRequestSchema.safeParse({ decision: 'maybe' }).success).toBe(false);
  });

  it('rejects an overlong reasonCode', () => {
    expect(ApprovalDecisionRequestSchema.safeParse({ decision: 'reject', reasonCode: 'x'.repeat(201) }).success).toBe(false);
  });
});

describe('ApprovalListQuerySchema', () => {
  it('coerces a string limit to a number', () => {
    const result = ApprovalListQuerySchema.safeParse({ limit: '10' });
    expect(result.success).toBe(true);
    expect(result.success && result.data.limit).toBe(10);
  });

  it('rejects a limit above the max', () => {
    expect(ApprovalListQuerySchema.safeParse({ limit: MAX_APPROVAL_LIST_LIMIT + 1 }).success).toBe(false);
  });

  it('rejects a non-positive limit', () => {
    expect(ApprovalListQuerySchema.safeParse({ limit: 0 }).success).toBe(false);
  });

  it('accepts no filters at all', () => {
    expect(ApprovalListQuerySchema.safeParse({}).success).toBe(true);
  });
});
