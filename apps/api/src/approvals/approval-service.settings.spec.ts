import { describe, expect, it } from 'vitest';
import { loadApprovalServiceSettingsFromEnv } from './approval-service.settings';
import { loadChatSettingsFromEnv } from '../chat/chat.settings';

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

describe('Stage 5 follow-up H3(iii): autoExecuteTimeoutMs stays comfortably inside the HTTP deadline', () => {
  // These two settings are loaded by two entirely independent env-var-driven loaders
  // (approval-service.settings.ts and chat.settings.ts) - nothing in either one's own
  // validation enforces this ordering, so a future change to either DEFAULT could silently
  // break the invariant PROJECT.md's Stage 5 design relies on: the auto-execute path's own
  // bounded timeout (ApprovalService.createFromProposal's withTimeout call) must resolve well
  // before chat.service.ts's own outer HTTP deadline race fires, or an auto-execute attempt
  // that's genuinely hanging would be cut off by the WRONG timeout (the generic
  // REQUEST_TIMEOUT 503, not the auto-execute path's own escalate-with-a-real-message
  // handling) - see run-agent.ts's own doc comment on the same "losing the HTTP race should be
  // unreachable in practice" reasoning for the agent loop's own totalDeadlineMs.
  it('the documented DEFAULT values satisfy autoExecuteTimeoutMs < httpDeadlineMs, with real margin to spare', () => {
    const { autoExecuteTimeoutMs } = loadApprovalServiceSettingsFromEnv({});
    const { httpDeadlineMs } = loadChatSettingsFromEnv({});
    expect(autoExecuteTimeoutMs).toBeLessThan(httpDeadlineMs);
    // Real margin, not just "less than" by a hair - the rest of a chat request (plan + compose
    // LLM calls, retrieval, get_order/track_shipment, the Approval row's own transactional
    // insert) also has to fit inside httpDeadlineMs, all before auto-execute even starts.
    expect(httpDeadlineMs - autoExecuteTimeoutMs).toBeGreaterThanOrEqual(10_000);
  });
});
