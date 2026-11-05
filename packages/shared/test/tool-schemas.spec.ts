import { describe, expect, it } from 'vitest';
import {
  GetOrderInputSchema,
  GetOrderOutputSchema,
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

describe('GetOrderOutputSchema', () => {
  function base(overrides: Partial<Record<string, unknown>> = {}) {
    return { status: 'delivered', total: 49.99, placedAt: '2026-01-01T00:00:00.000Z', customerRef: 'cust_1', ...overrides };
  }

  it('converts total from decimal dollars to integer cents', () => {
    const result = GetOrderOutputSchema.safeParse(base({ total: 49.99 }));
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.total).toBe(4999);
  });

  it('defaults alreadyRefundedTotal to 0 (in cents) when the field is absent', () => {
    const result = GetOrderOutputSchema.safeParse(base());
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.alreadyRefundedTotal).toBe(0);
  });

  it('converts a present alreadyRefundedTotal to integer cents', () => {
    const result = GetOrderOutputSchema.safeParse(base({ alreadyRefundedTotal: 120.0 }));
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.alreadyRefundedTotal).toBe(12000);
  });

  it('accepts a missing deliveredAt (order not yet delivered)', () => {
    const result = GetOrderOutputSchema.safeParse(base());
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.deliveredAt).toBeUndefined();
  });

  it('accepts a present deliveredAt', () => {
    const result = GetOrderOutputSchema.safeParse(base({ deliveredAt: '2026-01-02T00:00:00.000Z' }));
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.deliveredAt).toBe('2026-01-02T00:00:00.000Z');
  });

  it('rejects a negative alreadyRefundedTotal', () => {
    expect(GetOrderOutputSchema.safeParse(base({ alreadyRefundedTotal: -5 })).success).toBe(false);
  });

  it('rejects an alreadyRefundedTotal with more than two decimal places', () => {
    expect(GetOrderOutputSchema.safeParse(base({ alreadyRefundedTotal: 10.999 })).success).toBe(false);
  });
});
