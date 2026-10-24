import { describe, expect, it } from 'vitest';
import {
  GetOrderInputSchema,
  IssueRefundInputSchema,
  EscalateToHumanInputSchema,
} from '../src/tool-schemas';

describe('tool input schemas', () => {
  it('GetOrderInputSchema requires a valid order_id', () => {
    expect(GetOrderInputSchema.safeParse({ order_id: 'ORD-1001' }).success).toBe(true);
    expect(GetOrderInputSchema.safeParse({ order_id: '' }).success).toBe(false);
  });

  it('IssueRefundInputSchema requires a positive amount and allows an optional idempotencyKey', () => {
    expect(
      IssueRefundInputSchema.safeParse({ order_id: 'ORD-1001', amount: 10 }).success,
    ).toBe(true);
    expect(
      IssueRefundInputSchema.safeParse({ order_id: 'ORD-1001', amount: -1 }).success,
    ).toBe(false);
    expect(
      IssueRefundInputSchema.safeParse({
        order_id: 'ORD-1001',
        amount: 10,
        idempotencyKey: 'retry-1',
      }).success,
    ).toBe(true);
  });

  it('EscalateToHumanInputSchema requires a non-empty summary', () => {
    expect(EscalateToHumanInputSchema.safeParse({ summary: 'help' }).success).toBe(true);
    expect(EscalateToHumanInputSchema.safeParse({ summary: '' }).success).toBe(false);
  });
});
