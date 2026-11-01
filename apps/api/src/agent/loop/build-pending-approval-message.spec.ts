import { describe, expect, it } from 'vitest';
import { buildPendingApprovalMessage } from './build-pending-approval-message';

describe('buildPendingApprovalMessage', () => {
  it('names the order id and the amount, formatted to two decimal places', () => {
    const message = buildPendingApprovalMessage('ORD-1001', 49.99);
    expect(message).toContain('ORD-1001');
    expect(message).toContain('$49.99');
  });

  it('never claims the refund has already been issued', () => {
    const message = buildPendingApprovalMessage('ORD-1006', 1249);
    expect(message.toLowerCase()).not.toContain('issued');
    expect(message.toLowerCase()).not.toContain('have been refunded');
  });

  it('pads a whole-dollar amount to two decimal places', () => {
    const message = buildPendingApprovalMessage('ORD-1006', 1249);
    expect(message).toContain('$1249.00');
  });
});
