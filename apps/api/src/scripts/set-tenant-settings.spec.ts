import { describe, expect, it } from 'vitest';
import { buildSettingsPatch, parseArgs, requireAutoExecuteConfirmation, requireTenantId } from './set-tenant-settings';

describe('parseArgs', () => {
  it('parses --key=value pairs and bare --flags', () => {
    expect(parseArgs(['--tenantId=acme', '--refundCap=2000', '--allow-test-db'])).toEqual({
      tenantId: 'acme',
      refundCap: '2000',
      'allow-test-db': true,
    });
  });
});

describe('requireTenantId', () => {
  it('accepts a valid tenant id', () => {
    expect(requireTenantId({ tenantId: 'acme' })).toBe('acme');
  });

  it('rejects a missing tenantId', () => {
    expect(() => requireTenantId({})).toThrow(/--tenantId is required/);
  });

  it('rejects a tenantId that does not match TENANT_ID_PATTERN', () => {
    expect(() => requireTenantId({ tenantId: 'Not Valid!' })).toThrow(/--tenantId is required/);
  });
});

describe('buildSettingsPatch', () => {
  it('leaves every field undefined when no flags are passed', () => {
    expect(buildSettingsPatch({})).toEqual({
      refundCap: undefined,
      approvalThreshold: undefined,
      refundWindowDays: undefined,
      autoExecuteRefunds: undefined,
      approvalExpiryDays: undefined,
      dailyRefundCountLimit: undefined,
    });
  });

  it('parses every flag when all are passed', () => {
    expect(
      buildSettingsPatch({
        refundCap: '2000',
        approvalThreshold: '250',
        refundWindowDays: '30',
        autoExecuteRefunds: 'true',
        approvalExpiryDays: '7',
        dailyRefundCountLimit: '3',
      }),
    ).toEqual({
      refundCap: 2000,
      approvalThreshold: 250,
      refundWindowDays: 30,
      autoExecuteRefunds: true,
      approvalExpiryDays: 7,
      dailyRefundCountLimit: 3,
    });
  });

  it('rejects a negative refundCap', () => {
    expect(() => buildSettingsPatch({ refundCap: '-5' })).toThrow(/--refundCap must be a non-negative number/);
  });

  it('accepts refundCap: 0 (a tenant that allows no refunds at all)', () => {
    expect(buildSettingsPatch({ refundCap: '0' }).refundCap).toBe(0);
  });

  it('rejects a non-integer refundWindowDays', () => {
    expect(() => buildSettingsPatch({ refundWindowDays: '30.5' })).toThrow(/--refundWindowDays must be a positive integer/);
  });

  it('rejects a zero or negative approvalExpiryDays', () => {
    expect(() => buildSettingsPatch({ approvalExpiryDays: '0' })).toThrow(/--approvalExpiryDays must be a positive integer/);
  });

  it('parses autoExecuteRefunds: false explicitly (distinct from omitted)', () => {
    expect(buildSettingsPatch({ autoExecuteRefunds: 'false' }).autoExecuteRefunds).toBe(false);
  });

  it('rejects an invalid autoExecuteRefunds value', () => {
    expect(() => buildSettingsPatch({ autoExecuteRefunds: 'yes' })).toThrow(/--autoExecuteRefunds must be "true" or "false"/);
  });
});

describe('requireAutoExecuteConfirmation (amendment N-c)', () => {
  it('rejects enabling autoExecuteRefunds without --confirmAutoExecute', () => {
    expect(() => requireAutoExecuteConfirmation({ autoExecuteRefunds: true }, {})).toThrow(/--confirmAutoExecute/);
  });

  it('accepts enabling autoExecuteRefunds with --confirmAutoExecute', () => {
    expect(() => requireAutoExecuteConfirmation({ autoExecuteRefunds: true }, { confirmAutoExecute: true })).not.toThrow();
  });

  it('never requires confirmation when autoExecuteRefunds is not being set to true in this call', () => {
    expect(() => requireAutoExecuteConfirmation({}, {})).not.toThrow();
    expect(() => requireAutoExecuteConfirmation({ autoExecuteRefunds: false }, {})).not.toThrow();
  });
});
