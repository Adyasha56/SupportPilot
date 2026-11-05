/**
 * Pure facts derived from tool results, computed in code - never by the
 * model (PROJECT.md's Agent loop design: "the model only ever reads facts,
 * never computes a date or a dollar amount itself"). Every function here
 * takes an injected clock (`() => Date`), matching the project's existing
 * clock-injection pattern (mock-store orders, retrieval tests) - no
 * function reads the real wall clock directly, so every edge case below is
 * exactly reproducible in a test.
 *
 * GAP CLOSED (Stage 2 flagged this, Stage 3's data-contract follow-up fixed
 * it): GetOrderOutputSchema now exposes `deliveredAt` and
 * `alreadyRefundedTotal`, and converts both of its money fields
 * (`total`, `alreadyRefundedTotal`) to integer CENTS at that boundary
 * (packages/shared/src/tool-schemas.ts). `remainingRefundable` below
 * therefore takes cents directly and does no unit conversion of its own -
 * by the time a caller has a GetOrderOutput, the conversion already
 * happened once, at the one place it belongs.
 */

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Whole 24-hour periods elapsed since `deliveredAt`, floored. "Whole days"
 * here means a fixed 24-hour duration measured from the delivery instant,
 * NOT a calendar-date difference - 23h59m elapsed is 0 days, exactly 24h is
 * 1 day. This sidesteps timezone/UTC-boundary ambiguity entirely: ISO
 * timestamps (with their own offset or `Z`) parse to the same absolute
 * instant regardless of either party's local timezone, and subtracting two
 * instants in milliseconds needs no calendar-day alignment at all.
 *
 * Returns `undefined` - never a number - when:
 * - `deliveredAt` is missing (order not yet delivered), or
 * - `deliveredAt` is in the future relative to `clock()` (anomalous data -
 *   a delivery timestamp should never be ahead of "now"). This is
 *   deliberately NOT clamped to 0: a refund-window check like
 *   `daysSinceDelivery <= 30` would read a clamped 0 as "just delivered,
 *   definitely in window" - the unsafe direction for a money-moving
 *   decision. Treating it as `undefined` (unknown) instead forces the
 *   caller down the same "cannot confirm, don't guess" path missing data
 *   already takes, matching PROJECT.md's guardrail: "if unsure, clarify or
 *   escalate, never guess an action."
 */
export function daysSinceDelivery(deliveredAt: string | undefined, clock: () => Date): number | undefined {
  if (!deliveredAt) {
    return undefined;
  }
  const elapsedMs = clock().getTime() - new Date(deliveredAt).getTime();
  if (elapsedMs < 0) {
    return undefined;
  }
  return Math.floor(elapsedMs / MS_PER_DAY);
}

/**
 * Whole days PAST `estimatedDelivery`, floored, or 0 if the estimate
 * hasn't arrived yet. Unlike daysSinceDelivery above, "not yet due" is a
 * fully known, unambiguous, SAFE fact (an order that isn't late yet really
 * does have zero days of lateness - there's nothing uncertain to guess
 * about), so this clamps to 0 rather than returning `undefined`. Only a
 * missing `estimatedDelivery` returns `undefined` (we genuinely don't know
 * whether it's late at all).
 */
export function daysPastEstimate(estimatedDelivery: string | undefined, clock: () => Date): number | undefined {
  if (!estimatedDelivery) {
    return undefined;
  }
  const elapsedMs = clock().getTime() - new Date(estimatedDelivery).getTime();
  if (elapsedMs <= 0) {
    return 0;
  }
  return Math.floor(elapsedMs / MS_PER_DAY);
}

/**
 * Integer cents remaining refundable on an order, given its total and
 * whatever has already been refunded against it - BOTH already integer
 * cents (straight from a verified GetOrderOutput's `total`/
 * `alreadyRefundedTotal`, already converted at the tool-output boundary -
 * see this file's top comment). No unit conversion happens here; this is
 * a plain integer subtraction, clamped at 0: if `alreadyRefundedCents`
 * ever exceeds `orderTotalCents` (a data inconsistency that should never
 * happen but must never be trusted blindly), the safe reading is "nothing
 * left to refund," never a negative number a careless
 * `amount <= remainingRefundable` check could be tricked by.
 */
export function remainingRefundable(orderTotalCents: number, alreadyRefundedCents: number): number {
  return Math.max(orderTotalCents - alreadyRefundedCents, 0);
}
