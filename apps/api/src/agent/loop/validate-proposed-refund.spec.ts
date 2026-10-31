import { describe, expect, it } from 'vitest';
import { validateProposedRefund, ValidateProposedRefundState } from './validate-proposed-refund';

function makeState(overrides: Partial<ValidateProposedRefundState> = {}): ValidateProposedRefundState {
  return {
    runId: 'run_1',
    verifiedOrderIds: new Set(['ORD-1001']),
    orderTotalCents: 10000,
    alreadyRefundedCents: 0,
    reasonCitations: ['k1'],
    ...overrides,
  };
}

describe('validateProposedRefund', () => {
  it('accepts a valid refund within the remaining refundable amount', () => {
    const result = validateProposedRefund({ order_id: 'ORD-1001', amount: 49.99 }, makeState());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.action).toEqual({
        tool: 'issue_refund',
        args: { order_id: 'ORD-1001', amount: 49.99, idempotencyKey: expect.stringMatching(/^[0-9a-f]{64}$/) },
        reasonCitations: ['k1'],
      });
    }
  });

  it('rejects an order id that is not verified', () => {
    const result = validateProposedRefund({ order_id: 'ORD-9999', amount: 10 }, makeState());
    expect(result).toEqual({ ok: false, reason: 'ORDER_NOT_VERIFIED' });
  });

  it('rejects a zero amount', () => {
    const result = validateProposedRefund({ order_id: 'ORD-1001', amount: 0 }, makeState());
    expect(result).toEqual({ ok: false, reason: 'INVALID_AMOUNT' });
  });

  it('rejects a negative amount', () => {
    const result = validateProposedRefund({ order_id: 'ORD-1001', amount: -10 }, makeState());
    expect(result).toEqual({ ok: false, reason: 'INVALID_AMOUNT' });
  });

  it('rejects an amount with more than two decimal places', () => {
    const result = validateProposedRefund({ order_id: 'ORD-1001', amount: 49.999 }, makeState());
    expect(result).toEqual({ ok: false, reason: 'INVALID_AMOUNT' });
  });

  it('accepts the classic 0.1 + 0.2 float edge case as a valid two-decimal amount', () => {
    const amount = 0.1 + 0.2; // 0.30000000000000004 in raw IEEE-754
    const result = validateProposedRefund({ order_id: 'ORD-1001', amount }, makeState({ orderTotalCents: 100 }));
    expect(result.ok).toBe(true);
  });

  it('rejects an amount that exceeds remainingRefundable', () => {
    const result = validateProposedRefund({ order_id: 'ORD-1001', amount: 100.01 }, makeState({ orderTotalCents: 10000 }));
    expect(result).toEqual({ ok: false, reason: 'AMOUNT_EXCEEDS_REMAINING_REFUNDABLE' });
  });

  it('rejects an amount that exactly equals the total but the order was already fully refunded', () => {
    const result = validateProposedRefund(
      { order_id: 'ORD-1001', amount: 100 },
      makeState({ orderTotalCents: 10000, alreadyRefundedCents: 10000 }),
    );
    expect(result).toEqual({ ok: false, reason: 'AMOUNT_EXCEEDS_REMAINING_REFUNDABLE' });
  });

  it('accepts an amount that exactly equals remainingRefundable at the cent boundary (float edge case)', () => {
    // orderTotalCents - alreadyRefundedCents = 30 cents; the proposed
    // amount (0.1 + 0.2 dollars) must convert to exactly 30 cents too, not
    // drift due to float error.
    const result = validateProposedRefund(
      { order_id: 'ORD-1001', amount: 0.1 + 0.2 },
      makeState({ orderTotalCents: 50, alreadyRefundedCents: 20 }),
    );
    expect(result.ok).toBe(true);
  });

  it('generates the same idempotencyKey for the same runId/orderId/amount - deterministic, not random', () => {
    const first = validateProposedRefund({ order_id: 'ORD-1001', amount: 10 }, makeState());
    const second = validateProposedRefund({ order_id: 'ORD-1001', amount: 10 }, makeState());
    expect(first.ok && second.ok).toBe(true);
    if (first.ok && second.ok) {
      expect(first.action.args.idempotencyKey).toBe(second.action.args.idempotencyKey);
    }
  });

  it('generates a different idempotencyKey for a different amount on the same order', () => {
    const first = validateProposedRefund({ order_id: 'ORD-1001', amount: 10 }, makeState());
    const second = validateProposedRefund({ order_id: 'ORD-1001', amount: 20 }, makeState());
    expect(first.ok && second.ok).toBe(true);
    if (first.ok && second.ok) {
      expect(first.action.args.idempotencyKey).not.toBe(second.action.args.idempotencyKey);
    }
  });

  it('generates a different idempotencyKey for a different runId, same order and amount', () => {
    const first = validateProposedRefund({ order_id: 'ORD-1001', amount: 10 }, makeState({ runId: 'run_1' }));
    const second = validateProposedRefund({ order_id: 'ORD-1001', amount: 10 }, makeState({ runId: 'run_2' }));
    expect(first.ok && second.ok).toBe(true);
    if (first.ok && second.ok) {
      expect(first.action.args.idempotencyKey).not.toBe(second.action.args.idempotencyKey);
    }
  });
});
