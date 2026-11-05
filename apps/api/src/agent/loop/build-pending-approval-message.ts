/**
 * The customer-facing message for outcome `pending_approval`, built ENTIRELY
 * in code from validated facts (order id, amount) - never from the model's
 * own free text. Real run finding (Stage 4, finding 5): the model's own
 * message for this outcome said "I have submitted a refund proposal" (true,
 * but close enough to "issued" that it's not worth the risk) and separately
 * mentioned an irrelevant policy threshold for a small amount - both are
 * prompt-following problems that a fixed template simply cannot have, since
 * there is no free text left for the model to get wrong. `amountDollars` is
 * the already-validated amount from validateProposedRefund's own output
 * (ProposedAction.args.amount), never the model's raw proposedRefund claim.
 */
export function buildPendingApprovalMessage(orderId: string, amountDollars: number): string {
  return `I've submitted a refund request of $${amountDollars.toFixed(2)} for order ${orderId}. Since this requires manager approval, a team member will review it before it's processed.`;
}
