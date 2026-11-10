/**
 * Every customer-facing message this module produces is built ENTIRELY in
 * code from validated facts (order id, amount) - never from admin free
 * text or model output, the same discipline build-pending-approval-message.ts
 * already established for Milestone 3's own pending_approval message
 * (reused here unchanged, not duplicated - see ApprovalService). Pure
 * functions, no I/O, trivially table-tested.
 */

export function buildAlreadyUnderReviewMessage(orderId: string): string {
  return `There's already a refund request under review for order ${orderId}. I've flagged this for a team member to follow up.`;
}

export function buildAutoExecutedMessage(orderId: string, amountDollars: number): string {
  return `Good news — your refund of $${amountDollars.toFixed(2)} for order ${orderId} has been issued.`;
}

/** Decision-time, terminal, non-retryable denial (e.g. the re-check caught the order had already changed) - never shown for an ambiguous or needs-reconciliation outcome, which stay silent until resolved. */
export function buildTerminalDenialMessage(orderId: string): string {
  return `We've reviewed your refund request for order ${orderId} and are not able to approve it. I've flagged this for a team member to follow up.`;
}

export function buildApprovedAndExecutedMessage(orderId: string, amountDollars: number): string {
  return `Your refund of $${amountDollars.toFixed(2)} for order ${orderId} has been approved and issued.`;
}

export function buildRejectedMessage(orderId: string): string {
  return `We've reviewed your refund request for order ${orderId} and are not able to approve it at this time. A team member can follow up if you have questions.`;
}
