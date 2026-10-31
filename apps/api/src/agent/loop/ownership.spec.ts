import { describe, expect, it } from 'vitest';
import { GetOrderOutput } from '@supportpilot/shared';
import { acceptOrderResult, assertToolRequestAllowed, OwnershipState } from './ownership';

function makeState(overrides: Partial<OwnershipState> = {}): OwnershipState {
  return { verifiedCustomerRef: 'cust_1', verifiedOrderIds: new Set(), ...overrides };
}

function makeOutput(overrides: Partial<GetOrderOutput> = {}): GetOrderOutput {
  return { status: 'delivered', total: 49.99, placedAt: '2026-10-01T00:00:00.000Z', customerRef: 'cust_1', ...overrides };
}

describe('acceptOrderResult', () => {
  it('adds the order id when customerRef matches the authenticated caller', () => {
    const state = makeState();
    const next = acceptOrderResult(state, 'ORD-1001', makeOutput({ customerRef: 'cust_1' }));
    expect(next.verifiedOrderIds.has('ORD-1001')).toBe(true);
  });

  it('does not mutate the original state object', () => {
    const state = makeState();
    acceptOrderResult(state, 'ORD-1001', makeOutput({ customerRef: 'cust_1' }));
    expect(state.verifiedOrderIds.has('ORD-1001')).toBe(false);
  });

  it('leaves state unchanged on a customerRef mismatch (another customer\'s order)', () => {
    const state = makeState({ verifiedCustomerRef: 'cust_1' });
    const next = acceptOrderResult(state, 'ORD-1001', makeOutput({ customerRef: 'cust_2' }));
    expect(next.verifiedOrderIds.has('ORD-1001')).toBe(false);
    expect(next).toEqual(state);
  });

  it('produces an identical result for "wrong customer" and "would-be not-found" - no distinguishing signal', () => {
    const state = makeState({ verifiedCustomerRef: 'cust_1' });
    const mismatchResult = acceptOrderResult(state, 'ORD-1001', makeOutput({ customerRef: 'cust_2' }));
    // Simulates what the loop does when get_order fails entirely (NOT_FOUND):
    // acceptOrderResult is simply never called, so state stays as-is.
    const notFoundResult = state;
    expect(mismatchResult).toEqual(notFoundResult);
  });

  it('preserves already-verified ids and adds the new one', () => {
    const state = makeState({ verifiedOrderIds: new Set(['ORD-9999']) });
    const next = acceptOrderResult(state, 'ORD-1001', makeOutput({ customerRef: 'cust_1' }));
    expect([...next.verifiedOrderIds].sort()).toEqual(['ORD-1001', 'ORD-9999']);
  });

  it('is idempotent - accepting the same already-verified order again changes nothing observable', () => {
    const state = makeState({ verifiedOrderIds: new Set(['ORD-1001']) });
    const next = acceptOrderResult(state, 'ORD-1001', makeOutput({ customerRef: 'cust_1' }));
    expect([...next.verifiedOrderIds]).toEqual(['ORD-1001']);
  });
});

describe('assertToolRequestAllowed', () => {
  it('allows get_order for any order id, verified or not', () => {
    const outcome = assertToolRequestAllowed({ tool: 'get_order', order_id: 'ORD-1001' }, new Set());
    expect(outcome).toEqual({ allowed: true });
  });

  it('allows track_shipment for a verified order id', () => {
    const outcome = assertToolRequestAllowed({ tool: 'track_shipment', order_id: 'ORD-1001' }, new Set(['ORD-1001']));
    expect(outcome).toEqual({ allowed: true });
  });

  it('denies track_shipment for an unverified order id', () => {
    const outcome = assertToolRequestAllowed({ tool: 'track_shipment', order_id: 'ORD-1001' }, new Set());
    expect(outcome).toEqual({ allowed: false, reason: 'ORDER_NOT_VERIFIED' });
  });

  it('denies track_shipment for an order verified under a different id (another customer\'s order probe)', () => {
    const outcome = assertToolRequestAllowed({ tool: 'track_shipment', order_id: 'ORD-9999' }, new Set(['ORD-1001']));
    expect(outcome).toEqual({ allowed: false, reason: 'ORDER_NOT_VERIFIED' });
  });
});
