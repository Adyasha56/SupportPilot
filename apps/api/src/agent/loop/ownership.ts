import { GetOrderOutput } from '@supportpilot/shared';

/**
 * The slice of AgentState (built in Stage 3) ownership checking actually
 * needs - kept minimal and decoupled from the full AgentState shape so
 * these functions stay pure and testable without the rest of the loop.
 */
export interface OwnershipState {
  /** The authenticated caller's customerRef for this run - set once, never changes mid-run. */
  readonly verifiedCustomerRef: string;
  /** Order ids confirmed, this run, to belong to verifiedCustomerRef - see PROJECT.md's Agent loop design. */
  readonly verifiedOrderIds: ReadonlySet<string>;
}

/**
 * Adds `orderId` to `verifiedOrderIds` ONLY when `getOrderOutput.customerRef`
 * equals the authenticated caller's `verifiedCustomerRef` - otherwise
 * returns `state` completely unchanged. A mismatch produces the EXACT same
 * observable result as "the order doesn't exist" (no new field, no thrown
 * error, no distinguishing log) - this is the structural fix for "another
 * customer's order": the loop's next step literally cannot tell the two
 * cases apart, so it can never leak "that order belongs to someone else."
 *
 * `orderId` is a separate parameter rather than read off `getOrderOutput`
 * because GetOrderOutputSchema has no `order_id` field of its own (the
 * tool runner's caller already knows which id it asked for; the output
 * only carries what the upstream connector returned) - PROJECT.md's
 * `acceptOrderResult(state, getOrderOutput)` sketch is followed in spirit,
 * with the id threaded through explicitly rather than assumed to be on the
 * output.
 */
export function acceptOrderResult(state: OwnershipState, orderId: string, getOrderOutput: GetOrderOutput): OwnershipState {
  if (getOrderOutput.customerRef !== state.verifiedCustomerRef) {
    return state;
  }
  if (state.verifiedOrderIds.has(orderId)) {
    return state;
  }
  const verifiedOrderIds = new Set(state.verifiedOrderIds);
  verifiedOrderIds.add(orderId);
  return { ...state, verifiedOrderIds };
}

export type ToolRequestDenialReason = 'ORDER_NOT_VERIFIED';

/**
 * A typed result, never a thrown exception - matching this project's
 * established pattern (tool runner, LlmProvider) of never throwing for an
 * expected, routine outcome. "Another customer tried to track an order
 * they don't own" is exactly that: routine, tested, handled by the next
 * planner/compose step, not a bug.
 */
export type ToolRequestAllowedOutcome = { allowed: true } | { allowed: false; reason: ToolRequestDenialReason };

/**
 * `get_order` is allowed for ANY id - that is how an id first becomes
 * verified in the first place (acceptOrderResult above); the loop would
 * have nothing to verify against if get_order itself required
 * pre-verification. `track_shipment` requires the order to already be in
 * `verifiedOrderIds` - it is never the first tool called for an order, so
 * requiring verification here is never a deadlock, only a real ordering
 * constraint the Stage 3 loop enforces (all get_order requests execute
 * before any track_shipment request in the same plan).
 */
export function assertToolRequestAllowed(
  request: { tool: 'get_order' | 'track_shipment'; order_id: string },
  verifiedOrderIds: ReadonlySet<string>,
): ToolRequestAllowedOutcome {
  if (request.tool === 'get_order') {
    return { allowed: true };
  }
  if (verifiedOrderIds.has(request.order_id)) {
    return { allowed: true };
  }
  return { allowed: false, reason: 'ORDER_NOT_VERIFIED' };
}
