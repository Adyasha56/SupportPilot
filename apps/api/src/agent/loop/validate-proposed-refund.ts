import { createHash } from 'node:crypto';
import { hasAtMostTwoDecimals, ProposedAction, ProposedActionSchema, toCents } from '@supportpilot/shared';
import { remainingRefundable } from './derived-facts';

export type ProposedRefundRejectionCode =
  | 'ORDER_NOT_VERIFIED'
  | 'INVALID_AMOUNT'
  | 'AMOUNT_EXCEEDS_REMAINING_REFUNDABLE'
  /** Defense in depth only - should never actually trigger given the checks above already ran; see the doc comment below. */
  | 'SCHEMA_VALIDATION_FAILED';

export type ValidateProposedRefundOutcome = { ok: true; action: ProposedAction } | { ok: false; reason: ProposedRefundRejectionCode };

export interface ValidateProposedRefundState {
  runId: string;
  verifiedOrderIds: ReadonlySet<string>;
  /**
   * The verified order's total and whatever has already been refunded
   * against it, in integer CENTS - straight from the SAME get_order
   * result that put the order in verifiedOrderIds (GetOrderOutputSchema
   * already converts both to cents at the tool-output boundary), never
   * re-fetched, never re-converted, and never trusted from the model's
   * own claim.
   */
  orderTotalCents: number;
  alreadyRefundedCents: number;
  /** citedChunkKeys from compose, already re-checked against the actually-retrieved set by citation-guard.ts BEFORE this function is ever called. */
  reasonCitations: string[];
}

/**
 * Generates the idempotencyKey in CODE - a hash of runId, orderId, and the
 * amount in cents, never anything the model supplies. Deterministic for a
 * given (runId, orderId, amountCents) triple: if this same run somehow
 * revalidates the identical proposal again (e.g. a retried step), it gets
 * the SAME key, so the mock store's own idempotency handling (same key =
 * replay, not a second refund) protects against a double-refund within one
 * run, not just across separate requests. Hex digest only uses
 * [0-9a-f] - always a safe match for the generic id pattern
 * IssueRefundInputSchema's idempotencyKey field requires.
 */
function generateIdempotencyKey(runId: string, orderId: string, amountCents: number): string {
  return createHash('sha256').update(`${runId}:${orderId}:${amountCents}`).digest('hex');
}

/**
 * The single gate every model-proposed refund must pass before it can
 * leave the loop as a ProposedAction (PROJECT.md's Agent loop design -
 * "code validates every proposedAction before it leaves the loop"). Checks
 * run in order and the first failure wins:
 * 1. order_id must already be verified (ownership.ts) - never re-trusts the
 *    model's own order_id claim.
 * 2. amount must be positive with at most two decimal places.
 * 3. amount must not exceed remainingRefundable, computed here from the
 *    verified order's own total/alreadyRefunded - never the model's claim
 *    about how much is refundable.
 * A pass builds the actual ProposedAction (idempotencyKey generated above)
 * and validates IT against ProposedActionSchema as a final defense-in-depth
 * check - this should never actually fail given the checks already run
 * (order_id came from a verified id, which was itself validated against
 * idSchema() when the order was first looked up; amount already passed
 * the same money rule the schema re-checks), but a hand-built object is
 * never returned without being run back through its own schema, matching
 * this project's "never trust raw model output" rule even for output code
 * itself just constructed.
 */
export function validateProposedRefund(
  proposal: { order_id: string; amount: number },
  state: ValidateProposedRefundState,
): ValidateProposedRefundOutcome {
  if (!state.verifiedOrderIds.has(proposal.order_id)) {
    return { ok: false, reason: 'ORDER_NOT_VERIFIED' };
  }

  if (!(proposal.amount > 0) || !hasAtMostTwoDecimals(proposal.amount)) {
    return { ok: false, reason: 'INVALID_AMOUNT' };
  }

  const remainingCents = remainingRefundable(state.orderTotalCents, state.alreadyRefundedCents);
  const amountCents = toCents(proposal.amount);
  if (amountCents > remainingCents) {
    return { ok: false, reason: 'AMOUNT_EXCEEDS_REMAINING_REFUNDABLE' };
  }

  const idempotencyKey = generateIdempotencyKey(state.runId, proposal.order_id, amountCents);
  const candidate = {
    tool: 'issue_refund' as const,
    args: { order_id: proposal.order_id, amount: proposal.amount, idempotencyKey },
    reasonCitations: state.reasonCitations,
  };

  const parsed = ProposedActionSchema.safeParse(candidate);
  if (!parsed.success) {
    return { ok: false, reason: 'SCHEMA_VALIDATION_FAILED' };
  }

  return { ok: true, action: parsed.data };
}
