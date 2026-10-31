import { centsEqual, centsGreaterThan } from '@supportpilot/shared';
import { Clock } from '../clock';
import { Order, Refund } from '../data/seed';

export type IssueRefundResult =
  | { kind: 'created'; refund: Refund }
  | { kind: 'idempotent-replay'; refund: Refund }
  | { kind: 'conflict'; reason: string }
  | { kind: 'invalid'; reason: string };

/**
 * Enforces facts only: an order can't be refunded twice, and a refund can't
 * exceed the order's total. Policy (windows, caps, approvals) is deliberately
 * NOT this store's job - that belongs to the agent/verifier in later milestones.
 */
export class RefundStore {
  private readonly refundsByOrder = new Map<string, Refund>();
  private readonly refundsByIdempotencyKey = new Map<string, Refund>();
  private counter = 9002;

  constructor(initial: Refund[]) {
    for (const refund of initial) {
      this.refundsByOrder.set(refund.orderId, refund);
      if (refund.idempotencyKey) {
        this.refundsByIdempotencyKey.set(refund.idempotencyKey, refund);
      }
    }
  }

  /** Read-only lookup used by the orders route to report how much (if anything) has already been refunded - the orders route never duplicates this onto the Order record itself, RefundStore stays the one source of truth. */
  getByOrder(orderId: string): Refund | undefined {
    return this.refundsByOrder.get(orderId);
  }

  issue(
    orderId: string,
    amount: number,
    order: Order,
    clock: Clock,
    idempotencyKey?: string,
  ): IssueRefundResult {
    if (idempotencyKey) {
      const existing = this.refundsByIdempotencyKey.get(idempotencyKey);
      if (existing) {
        if (existing.orderId === orderId && centsEqual(existing.amount, amount)) {
          return { kind: 'idempotent-replay', refund: existing };
        }
        return {
          kind: 'conflict',
          reason: 'idempotencyKey was already used with a different order or amount',
        };
      }
    }

    if (this.refundsByOrder.has(orderId)) {
      return { kind: 'conflict', reason: 'order has already been refunded' };
    }

    if (centsGreaterThan(amount, order.total)) {
      return { kind: 'invalid', reason: 'amount exceeds the order total' };
    }

    const refund: Refund = {
      id: `REF-${this.counter++}`,
      orderId,
      amount,
      status: 'refunded',
      idempotencyKey,
      createdAt: clock().toISOString(),
    };

    this.refundsByOrder.set(orderId, refund);
    if (idempotencyKey) {
      this.refundsByIdempotencyKey.set(idempotencyKey, refund);
    }

    return { kind: 'created', refund };
  }
}
