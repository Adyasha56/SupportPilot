import { describe, expect, it } from 'vitest';
import { MAX_REFUND_CAP, TenantSettingsValidationError, validateEffectiveTenantSettings } from './tenant-settings-validation';

describe('validateEffectiveTenantSettings', () => {
  it('accepts a fully empty effective settings object', () => {
    expect(() => validateEffectiveTenantSettings({})).not.toThrow();
  });

  it('accepts a valid, complete set of settings', () => {
    expect(() =>
      validateEffectiveTenantSettings({
        refundCap: 2000,
        approvalThreshold: 250,
        refundWindowDays: 30,
        autoExecuteRefunds: true,
        approvalExpiryDays: 7,
        dailyRefundCountLimit: 3,
      }),
    ).not.toThrow();
  });

  it('rejects a negative refundCap', () => {
    expect(() => validateEffectiveTenantSettings({ refundCap: -1 })).toThrow(TenantSettingsValidationError);
  });

  it('rejects a negative approvalThreshold', () => {
    expect(() => validateEffectiveTenantSettings({ approvalThreshold: -1 })).toThrow(TenantSettingsValidationError);
  });

  it('accepts refundCap: 0 (a tenant that allows no refunds at all)', () => {
    expect(() => validateEffectiveTenantSettings({ refundCap: 0 })).not.toThrow();
  });

  it('rejects refundCap above MAX_REFUND_CAP', () => {
    expect(() => validateEffectiveTenantSettings({ refundCap: MAX_REFUND_CAP + 1 })).toThrow(/must not exceed/);
  });

  it('accepts refundCap exactly at MAX_REFUND_CAP', () => {
    expect(() => validateEffectiveTenantSettings({ refundCap: MAX_REFUND_CAP })).not.toThrow();
  });

  it('rejects approvalThreshold greater than refundCap', () => {
    expect(() => validateEffectiveTenantSettings({ refundCap: 2000, approvalThreshold: 2001 })).toThrow(/approvalThreshold must not exceed refundCap/);
  });

  it('accepts approvalThreshold exactly equal to refundCap', () => {
    expect(() => validateEffectiveTenantSettings({ refundCap: 2000, approvalThreshold: 2000 })).not.toThrow();
  });

  it('does not cross-check approvalThreshold against refundCap when only one is present in the effective settings', () => {
    expect(() => validateEffectiveTenantSettings({ approvalThreshold: 999999 })).not.toThrow();
  });

  it('rejects a non-integer refundWindowDays', () => {
    expect(() => validateEffectiveTenantSettings({ refundWindowDays: 30.5 })).toThrow(/refundWindowDays must be a positive integer/);
  });

  it('rejects a zero refundWindowDays', () => {
    expect(() => validateEffectiveTenantSettings({ refundWindowDays: 0 })).toThrow(/refundWindowDays must be a positive integer/);
  });

  it('rejects a zero or non-integer approvalExpiryDays', () => {
    expect(() => validateEffectiveTenantSettings({ approvalExpiryDays: 0 })).toThrow(/approvalExpiryDays must be a positive integer/);
    expect(() => validateEffectiveTenantSettings({ approvalExpiryDays: 1.5 })).toThrow(/approvalExpiryDays must be a positive integer/);
  });

  it('rejects a zero or non-integer dailyRefundCountLimit', () => {
    expect(() => validateEffectiveTenantSettings({ dailyRefundCountLimit: 0 })).toThrow(/dailyRefundCountLimit must be a positive integer/);
    expect(() => validateEffectiveTenantSettings({ dailyRefundCountLimit: 2.5 })).toThrow(/dailyRefundCountLimit must be a positive integer/);
  });

  it('rejects autoExecuteRefunds: true with no dailyRefundCountLimit at all', () => {
    expect(() => validateEffectiveTenantSettings({ autoExecuteRefunds: true })).toThrow(/autoExecuteRefunds requires dailyRefundCountLimit/);
  });

  it('accepts autoExecuteRefunds: true when dailyRefundCountLimit is present', () => {
    expect(() => validateEffectiveTenantSettings({ autoExecuteRefunds: true, dailyRefundCountLimit: 1 })).not.toThrow();
  });

  it('accepts autoExecuteRefunds: false with no dailyRefundCountLimit', () => {
    expect(() => validateEffectiveTenantSettings({ autoExecuteRefunds: false })).not.toThrow();
  });
});
