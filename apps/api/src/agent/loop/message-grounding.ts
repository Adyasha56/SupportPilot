/**
 * A grounding check for the one category of model-written text the loop
 * still uses as-is: `reply`/`clarify` messages (PROJECT.md's Agent loop
 * design - `pending_approval` and `escalate` are built entirely in code,
 * see build-pending-approval-message.ts and run-agent.ts's GENERIC_ESCALATE_MESSAGE).
 * Real run finding (Stage 4, finding 5): a model-written message can still
 * assert a dollar amount or order id that nothing in the run actually
 * supports - most dangerously, one planted by a prompt-injection attempt
 * (e.g. a fake DERIVED_FACTS line in the customer's own message). This
 * never re-validates an EXECUTED action (that's validateProposedRefund's
 * job) - it only checks that numbers/ids a message merely *mentions* in
 * prose are backed by something the run itself actually knows, so an
 * invented figure never reaches the customer dressed as fact.
 */

export interface GroundingFacts {
  knownOrderIds: ReadonlySet<string>;
  /** Integer cents - matches how every money fact already flows through this codebase (see derived-facts.ts). */
  knownAmountsCents: ReadonlySet<number>;
}

export interface GroundingCheckResult {
  grounded: boolean;
  /** Counts only - never which id or amount, and never the message text itself. See run-agent.spec.ts's log-capture test for why. */
  ungroundedOrderIdCount: number;
  ungroundedAmountCount: number;
}

const ORDER_ID_PATTERN = /\bORD-\d+\b/g;
const DOLLAR_SIGN_PATTERN = /\$\s?(\d+(?:\.\d{1,2})?)/g;
const DOLLARS_WORD_PATTERN = /(\d+(?:\.\d{1,2})?)\s*dollars\b/gi;

function extractOrderIds(text: string): string[] {
  return [...text.matchAll(ORDER_ID_PATTERN)].map((m) => m[0]);
}

function extractAmountCents(text: string): number[] {
  const amounts: number[] = [];
  for (const m of text.matchAll(DOLLAR_SIGN_PATTERN)) {
    amounts.push(Math.round(parseFloat(m[1]) * 100));
  }
  for (const m of text.matchAll(DOLLARS_WORD_PATTERN)) {
    amounts.push(Math.round(parseFloat(m[1]) * 100));
  }
  return amounts;
}

/**
 * Gathers every order id and dollar amount this run actually knows about,
 * from sources the model never controls: verified/attempted order ids from
 * tool results, the order totals/already-refunded/remaining-refundable
 * amounts code itself computed, and any id/amount literally present in a
 * retrieved policy chunk's own text (so a message legitimately quoting a
 * policy's stated threshold, e.g. "$250", is never flagged).
 */
export function buildGroundingFacts(input: {
  orderFacts: Array<{ orderId: string; totalCents: number; alreadyRefundedCents: number; remainingRefundableCents: number }>;
  toolResultOrderIds: string[];
  retrievedChunkTexts: string[];
}): GroundingFacts {
  const knownOrderIds = new Set<string>();
  const knownAmountsCents = new Set<number>();

  for (const order of input.orderFacts) {
    knownOrderIds.add(order.orderId);
    knownAmountsCents.add(order.totalCents);
    knownAmountsCents.add(order.alreadyRefundedCents);
    knownAmountsCents.add(order.remainingRefundableCents);
  }
  for (const orderId of input.toolResultOrderIds) {
    knownOrderIds.add(orderId);
  }
  for (const text of input.retrievedChunkTexts) {
    for (const orderId of extractOrderIds(text)) {
      knownOrderIds.add(orderId);
    }
    for (const cents of extractAmountCents(text)) {
      knownAmountsCents.add(cents);
    }
  }

  return { knownOrderIds, knownAmountsCents };
}

export function checkMessageGrounding(message: string, facts: GroundingFacts): GroundingCheckResult {
  const ungroundedOrderIdCount = extractOrderIds(message).filter((id) => !facts.knownOrderIds.has(id)).length;
  const ungroundedAmountCount = extractAmountCents(message).filter((cents) => !facts.knownAmountsCents.has(cents)).length;
  return {
    grounded: ungroundedOrderIdCount === 0 && ungroundedAmountCount === 0,
    ungroundedOrderIdCount,
    ungroundedAmountCount,
  };
}
