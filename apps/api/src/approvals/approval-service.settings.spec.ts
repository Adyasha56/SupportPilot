import { describe, expect, it } from 'vitest';
import { loadApprovalServiceSettingsFromEnv } from './approval-service.settings';

describe('loadApprovalServiceSettingsFromEnv', () => {
  it('uses the documented defaults when nothing is set', () => {
    expect(loadApprovalServiceSettingsFromEnv({})).toEqual({ executionLeaseMs: 60_000, autoExecuteTimeoutMs: 15_000 });
  });

  it('reads both values from the environment when set', () => {
    expect(loadApprovalServiceSettingsFromEnv({ APPROVAL_EXECUTION_LEASE_MS: '30000', AUTO_EXECUTE_TIMEOUT_MS: '5000' })).toEqual({
      executionLeaseMs: 30_000,
      autoExecuteTimeoutMs: 5_000,
    });
  });

  it('rejects a non-positive executionLeaseMs', () => {
    expect(() => loadApprovalServiceSettingsFromEnv({ APPROVAL_EXECUTION_LEASE_MS: '0' })).toThrow();
  });

  it('rejects a non-positive autoExecuteTimeoutMs', () => {
    expect(() => loadApprovalServiceSettingsFromEnv({ AUTO_EXECUTE_TIMEOUT_MS: '-1' })).toThrow();
  });

  it('rejects a non-numeric value', () => {
    expect(() => loadApprovalServiceSettingsFromEnv({ APPROVAL_EXECUTION_LEASE_MS: 'not-a-number' })).toThrow();
  });
});
