import { describe, expect, it } from 'vitest';
import {
  buildAlreadyUnderReviewMessage,
  buildApprovedAndExecutedMessage,
  buildAutoExecutedMessage,
  buildRejectedMessage,
  buildTerminalDenialMessage,
} from './approval-message';

describe('approval-message templates', () => {
  it('buildAlreadyUnderReviewMessage names the order, never a verifier code', () => {
    expect(buildAlreadyUnderReviewMessage('ORD-1001')).toBe(
      "There's already a refund request under review for order ORD-1001. I've flagged this for a team member to follow up.",
    );
  });

  it('buildAutoExecutedMessage formats the amount to two decimals', () => {
    expect(buildAutoExecutedMessage('ORD-1001', 49.99)).toBe('Good news — your refund of $49.99 for order ORD-1001 has been issued.');
    expect(buildAutoExecutedMessage('ORD-1001', 50)).toBe('Good news — your refund of $50.00 for order ORD-1001 has been issued.');
  });

  it('buildTerminalDenialMessage never mentions a specific reason code', () => {
    const message = buildTerminalDenialMessage('ORD-1001');
    expect(message).toContain('ORD-1001');
    expect(message).not.toMatch(/[A-Z_]{5,}/); // no SCREAMING_SNAKE_CASE code leaks into customer text
  });

  it('buildApprovedAndExecutedMessage formats the amount to two decimals', () => {
    expect(buildApprovedAndExecutedMessage('ORD-1001', 1249)).toBe('Your refund of $1249.00 for order ORD-1001 has been approved and issued.');
  });

  it('buildRejectedMessage never mentions a specific reason code', () => {
    const message = buildRejectedMessage('ORD-1001');
    expect(message).toContain('ORD-1001');
    expect(message).not.toMatch(/[A-Z_]{5,}/);
  });
});
