/**
 * The one shared validator for a tenant's EFFECTIVE Milestone-4 settings -
 * "effective" meaning the merge of whatever is already stored with whatever
 * a given call is changing, never a single call's flags considered in
 * isolation. Used by both set-tenant-settings.ts (fail fast, before even
 * connecting where possible) and TenantRepository.updateSettings (the
 * authoritative enforcement - the one write path, so this is the one place
 * a bad combination can ever reach storage).
 */

export interface EffectiveTenantSettings {
  refundCap?: number;
  approvalThreshold?: number;
  refundWindowDays?: number;
  autoExecuteRefunds?: boolean;
  approvalExpiryDays?: number;
  dailyRefundCountLimit?: number;
}

/**
 * A hard operational ceiling on refundCap itself, independent of any
 * tenant's own choice - a typo like --refundCap=200000000 must never reach
 * storage. $100,000 is comfortably above this project's highest seeded
 * order (ORD-1006, $1249.00) with wide margin for a real tenant's own
 * higher-value orders, while still catching an obvious data-entry mistake.
 */
export const MAX_REFUND_CAP = 100_000;

export class TenantSettingsValidationError extends Error {}

function requireNonNegative(value: number | undefined, field: string): void {
  if (value !== undefined && value < 0) {
    throw new TenantSettingsValidationError(`${field} must not be negative.`);
  }
}

function requirePositiveInteger(value: number | undefined, field: string): void {
  if (value !== undefined && (!Number.isInteger(value) || value <= 0)) {
    throw new TenantSettingsValidationError(`${field} must be a positive integer.`);
  }
}

/** Throws TenantSettingsValidationError with a clear message on the first violation found; returns normally when the effective settings are all valid. */
export function validateEffectiveTenantSettings(effective: EffectiveTenantSettings): void {
  requireNonNegative(effective.refundCap, 'refundCap');
  requireNonNegative(effective.approvalThreshold, 'approvalThreshold');
  requirePositiveInteger(effective.refundWindowDays, 'refundWindowDays');
  requirePositiveInteger(effective.approvalExpiryDays, 'approvalExpiryDays');
  requirePositiveInteger(effective.dailyRefundCountLimit, 'dailyRefundCountLimit');

  if (effective.refundCap !== undefined && effective.refundCap > MAX_REFUND_CAP) {
    throw new TenantSettingsValidationError(`refundCap must not exceed ${MAX_REFUND_CAP}.`);
  }

  if (
    effective.refundCap !== undefined &&
    effective.approvalThreshold !== undefined &&
    effective.approvalThreshold > effective.refundCap
  ) {
    throw new TenantSettingsValidationError('approvalThreshold must not exceed refundCap.');
  }

  // Milestone 4 amendment J - a real friction point, not just a default: enabling
  // auto-execute without a daily count limit would let a single compromised or
  // misconfigured session issue an unbounded number of unattended refunds.
  if (effective.autoExecuteRefunds === true && effective.dailyRefundCountLimit === undefined) {
    throw new TenantSettingsValidationError('autoExecuteRefunds requires dailyRefundCountLimit to already be set, or set in this same call.');
  }
}
