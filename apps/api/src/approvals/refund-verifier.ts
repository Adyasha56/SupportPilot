import { toCents, VERIFIER_FAILURE_CODES, VerifierFailureCode } from '@supportpilot/shared';
import { daysSinceDelivery, remainingRefundable } from '../agent/loop/derived-facts';

/**
 * The order facts a refund proposal is checked against - already-cents
 * money fields, straight from the same GetOrderOutput boundary
 * validate-proposed-refund.ts already relies on. Never re-converted here.
 */
export interface RefundVerifierOrderSnapshot {
  status: string;
  customerRef: string;
  deliveredAt?: string;
  totalCents: number;
  alreadyRefundedCents: number;
}

/**
 * Tenant settings in their ORIGINAL storage units - refundCap/
 * approvalThreshold are decimal DOLLARS (Tenant.settings's existing
 * convention), never cents. This is the one place in refund-verifier.ts
 * that does a dollars -> cents conversion (amendment N-a) - everything
 * else entering this module is already in cents.
 */
export interface RefundVerifierTenantSettings {
  refundCap: number;
  approvalThreshold: number;
  refundWindowDays: number;
  autoExecuteRefunds: boolean;
  /** undefined means "no limit configured" - rule 9 is then never checked, never treated as 0. */
  dailyRefundCountLimit?: number;
}

export interface RefundVerifierInput {
  /** Already integer cents - the same boundary IssueRefundInputSchema/validate-proposed-refund.ts already converts at. */
  proposedAmountCents: number;
  order: RefundVerifierOrderSnapshot;
  verifiedCustomerRef: string;
  /** chunkKeys the compose step actually cited, already re-checked against the real retrieved set upstream of this call. */
  citations: string[];
  tenantSettings: RefundVerifierTenantSettings;
  /** Only meaningful when tenantSettings.dailyRefundCountLimit is set. */
  customerDailyRefundCount: number;
  clock: () => Date;
}

export interface RuleVerdict {
  code: VerifierFailureCode;
  passed: boolean;
}

export type RefundVerifierDecision = 'auto_execute' | 'require_approval';

export type RefundVerifierOutput =
  | { decision: RefundVerifierDecision; verdicts: RuleVerdict[] }
  | { decision: 'deny'; failedRuleCodes: VerifierFailureCode[]; verdicts: RuleVerdict[] };

const ELIGIBLE_ORDER_STATUS = 'delivered';

/**
 * Amendment F: every rule is evaluated independently - there is NO
 * short-circuiting. Each function below answers only "did THIS rule
 * pass", using whatever inputs it needs, even if an earlier rule already
 * failed (e.g. rule 5 still runs with whatever proposedAmountCents was
 * given, even if rule 2 already flagged it as invalid) - the point is to
 * surface every real problem in the audit trail, not to produce the
 * single most relevant one.
 */
function checkOwnership(input: RefundVerifierInput): boolean {
  return input.order.customerRef === input.verifiedCustomerRef;
}

function checkAmountValid(input: RefundVerifierInput): boolean {
  return Number.isInteger(input.proposedAmountCents) && input.proposedAmountCents > 0;
}

function checkStatusEligible(input: RefundVerifierInput): boolean {
  return input.order.status === ELIGIBLE_ORDER_STATUS;
}

function checkNotAlreadyFullyRefunded(input: RefundVerifierInput): boolean {
  return remainingRefundable(input.order.totalCents, input.order.alreadyRefundedCents) > 0;
}

function checkWithinRemainingRefundable(input: RefundVerifierInput): boolean {
  const remaining = remainingRefundable(input.order.totalCents, input.order.alreadyRefundedCents);
  return input.proposedAmountCents <= remaining;
}

/**
 * `daysSinceDelivery` returns undefined for both a missing AND a
 * future-dated deliveredAt (derived-facts.ts's own "cannot confirm, don't
 * guess" rule) - either way, this rule fails rather than guessing the
 * order is in-window.
 */
function checkWithinWindow(input: RefundVerifierInput): boolean {
  const days = daysSinceDelivery(input.order.deliveredAt, input.clock);
  return days !== undefined && days <= input.tenantSettings.refundWindowDays;
}

/** Amendment N-a's one conversion boundary: tenantSettings.refundCap (dollars) -> cents, compared against an already-cents amount. */
function checkWithinRefundCap(input: RefundVerifierInput): boolean {
  return input.proposedAmountCents <= toCents(input.tenantSettings.refundCap);
}

function checkHasCitation(input: RefundVerifierInput): boolean {
  return input.citations.length > 0;
}

/** Rule 9 only ever fails when a limit is actually configured - undefined means "no limit", never "limit of 0". */
function checkWithinDailyCount(input: RefundVerifierInput): boolean {
  const limit = input.tenantSettings.dailyRefundCountLimit;
  if (limit === undefined) {
    return true;
  }
  return input.customerDailyRefundCount < limit;
}

const RULE_CHECKS: Record<VerifierFailureCode, (input: RefundVerifierInput) => boolean> = {
  ORDER_OWNERSHIP_MISMATCH: checkOwnership,
  INVALID_AMOUNT: checkAmountValid,
  ORDER_STATUS_INELIGIBLE: checkStatusEligible,
  ALREADY_FULLY_REFUNDED: checkNotAlreadyFullyRefunded,
  AMOUNT_EXCEEDS_REMAINING_REFUNDABLE: checkWithinRemainingRefundable,
  OUTSIDE_REFUND_WINDOW: checkWithinWindow,
  AMOUNT_EXCEEDS_REFUND_CAP: checkWithinRefundCap,
  MISSING_POLICY_CITATION: checkHasCitation,
  DAILY_REFUND_COUNT_EXCEEDED: checkWithinDailyCount,
};

/**
 * The refund-verifier (PROJECT.md's Milestone 4 design, amendments F/N-a).
 * Pure, no I/O - every rule in VERIFIER_FAILURE_CODES's fixed order is
 * evaluated independently (no short-circuiting); `failedRuleCodes` lists
 * every rule that failed, in that same fixed order, for the audit record.
 * The caller decides what the customer sees - this function never builds
 * customer-facing text.
 */
export function verifyRefundProposal(input: RefundVerifierInput): RefundVerifierOutput {
  const verdicts: RuleVerdict[] = VERIFIER_FAILURE_CODES.map((code) => ({
    code,
    passed: RULE_CHECKS[code](input),
  }));

  const failedRuleCodes = verdicts.filter((v) => !v.passed).map((v) => v.code);
  if (failedRuleCodes.length > 0) {
    return { decision: 'deny', failedRuleCodes, verdicts };
  }

  const approvalThresholdCents = toCents(input.tenantSettings.approvalThreshold);
  const decision: RefundVerifierDecision =
    input.tenantSettings.autoExecuteRefunds && input.proposedAmountCents <= approvalThresholdCents ? 'auto_execute' : 'require_approval';

  return { decision, verdicts };
}
