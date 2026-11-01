import { describe, expect, it } from 'vitest';
import { buildGroundingFacts, checkMessageGrounding } from './message-grounding';

describe('buildGroundingFacts + checkMessageGrounding', () => {
  const facts = buildGroundingFacts({
    orderFacts: [{ orderId: 'ORD-1001', totalCents: 4999, alreadyRefundedCents: 0, remainingRefundableCents: 4999 }],
    toolResultOrderIds: ['ORD-1001', 'ORD-1008'],
    retrievedChunkTexts: ['Refunds over $250 require manager approval.'],
  });

  it('a message naming only known facts is grounded', () => {
    const result = checkMessageGrounding('Your order ORD-1001 has a remaining refundable amount of $49.99.', facts);
    expect(result.grounded).toBe(true);
    expect(result.ungroundedOrderIdCount).toBe(0);
    expect(result.ungroundedAmountCount).toBe(0);
  });

  it('flags an invented order id not present anywhere in the run', () => {
    const result = checkMessageGrounding('Your order ORD-9999 is being processed.', facts);
    expect(result.grounded).toBe(false);
    expect(result.ungroundedOrderIdCount).toBe(1);
  });

  it('flags an invented dollar amount not present anywhere in the run', () => {
    const result = checkMessageGrounding('I have refunded you $9999.99.', facts);
    expect(result.grounded).toBe(false);
    expect(result.ungroundedAmountCount).toBe(1);
  });

  it('does not flag a legitimate threshold quoted verbatim from a retrieved chunk', () => {
    const result = checkMessageGrounding('Please note that refunds over $250 require manager approval.', facts);
    expect(result.grounded).toBe(true);
    expect(result.ungroundedAmountCount).toBe(0);
  });

  it('does not flag an order id that only appeared in a (denied) tool result, never a successful one', () => {
    const result = checkMessageGrounding("I couldn't find order ORD-1008.", facts);
    expect(result.grounded).toBe(true);
  });

  it('a message with no order ids or amounts at all is trivially grounded', () => {
    const result = checkMessageGrounding('Could you tell me more about your issue?', facts);
    expect(result.grounded).toBe(true);
  });
});
