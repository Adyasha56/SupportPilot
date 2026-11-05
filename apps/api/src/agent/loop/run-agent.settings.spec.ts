import { describe, expect, it } from 'vitest';
import { loadRunAgentDeadlineSettingsFromEnv } from './run-agent.settings';

describe('loadRunAgentDeadlineSettingsFromEnv', () => {
  it('defaults to 10s per call, 30s total, 10s retrieval, 2 timeout retries', () => {
    const settings = loadRunAgentDeadlineSettingsFromEnv({});
    expect(settings).toEqual({
      perCallTimeoutMs: 10_000,
      totalDeadlineMs: 30_000,
      retrievalTimeoutMs: 10_000,
      timeoutMaxRetries: 2,
    });
  });

  it('picks up every value from env', () => {
    const settings = loadRunAgentDeadlineSettingsFromEnv({
      AGENT_PER_CALL_TIMEOUT_MS: '5000',
      AGENT_TOTAL_DEADLINE_MS: '20000',
      AGENT_RETRIEVAL_TIMEOUT_MS: '4000',
      AGENT_TIMEOUT_MAX_RETRIES: '1',
    });
    expect(settings).toEqual({
      perCallTimeoutMs: 5000,
      totalDeadlineMs: 20_000,
      retrievalTimeoutMs: 4000,
      timeoutMaxRetries: 1,
    });
  });

  it('throws a clear error when perCallTimeoutMs exceeds totalDeadlineMs rather than silently accepting an impossible config', () => {
    expect(() =>
      loadRunAgentDeadlineSettingsFromEnv({ AGENT_PER_CALL_TIMEOUT_MS: '40000', AGENT_TOTAL_DEADLINE_MS: '30000' }),
    ).toThrow(/Invalid RunAgentDeadlineSettings/);
  });

  it('throws a clear error on an invalid value rather than silently coercing it', () => {
    expect(() => loadRunAgentDeadlineSettingsFromEnv({ AGENT_TOTAL_DEADLINE_MS: 'not-a-number' })).toThrow(/Invalid RunAgentDeadlineSettings/);
  });
});
