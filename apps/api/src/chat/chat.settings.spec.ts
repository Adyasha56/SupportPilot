import { describe, expect, it } from 'vitest';
import { loadChatSettingsFromEnv } from './chat.settings';

describe('loadChatSettingsFromEnv', () => {
  it('boots with sane defaults when nothing is set', () => {
    const settings = loadChatSettingsFromEnv({});

    expect(settings.historyWindowSize).toBeGreaterThan(0);
    expect(settings.historyMaxChars).toBeGreaterThan(0);
    expect(settings.maxMessagesPerConversation).toBeGreaterThan(0);
    expect(settings.maxBodyBytes).toBeGreaterThan(0);
    expect(settings.rateLimitIpMaxRequests).toBeGreaterThan(0);
    expect(settings.rateLimitApiKeyMaxRequests).toBeGreaterThan(0);
    expect(settings.rateLimitTenantMaxRequests).toBeGreaterThan(0);
    expect(settings.rateLimitCustomerRefMaxRequests).toBeGreaterThan(0);
    expect(settings.inFlightMaxRuns).toBeGreaterThan(0);
    expect(settings.inFlightMaxQueued).toBeGreaterThanOrEqual(0);
    expect(settings.conversationLockTtlMs).toBeGreaterThan(0);
    expect(settings.httpDeadlineMs).toBeGreaterThan(0);
    expect(settings.retentionDays).toBeGreaterThan(0);
    expect(settings.maxActiveCustomerKeysPerTenant).toBeGreaterThan(0);
  });

  it('the default conversation lock TTL and HTTP deadline both stay above the documented 30s agent run deadline', () => {
    // run-agent.settings.ts's own default AGENT_TOTAL_DEADLINE_MS is 30000 -
    // both of these must stay comfortably above it (see each field's own
    // doc comment in chat.settings.ts for why that relationship matters).
    const settings = loadChatSettingsFromEnv({});
    expect(settings.conversationLockTtlMs).toBeGreaterThan(30_000);
    expect(settings.httpDeadlineMs).toBeGreaterThan(30_000);
  });

  it('picks up every overridable value from env', () => {
    const settings = loadChatSettingsFromEnv({
      CHAT_HISTORY_WINDOW_SIZE: '5',
      CHAT_HISTORY_MAX_CHARS: '3000',
      CHAT_MAX_MESSAGES_PER_CONVERSATION: '20',
      CHAT_MAX_BODY_BYTES: '16000',
      CHAT_RATE_LIMIT_IP_MAX_REQUESTS: '10',
      CHAT_RATE_LIMIT_IP_WINDOW_MS: '30000',
      CHAT_RATE_LIMIT_IP_MAX_ENTRIES: '1000',
      CHAT_RATE_LIMIT_API_KEY_MAX_REQUESTS: '30',
      CHAT_RATE_LIMIT_API_KEY_WINDOW_MS: '30000',
      CHAT_RATE_LIMIT_API_KEY_MAX_ENTRIES: '1000',
      CHAT_RATE_LIMIT_TENANT_MAX_REQUESTS: '60',
      CHAT_RATE_LIMIT_TENANT_WINDOW_MS: '30000',
      CHAT_RATE_LIMIT_TENANT_MAX_ENTRIES: '300',
      CHAT_RATE_LIMIT_CUSTOMER_REF_MAX_REQUESTS: '5',
      CHAT_RATE_LIMIT_CUSTOMER_REF_WINDOW_MS: '30000',
      CHAT_RATE_LIMIT_CUSTOMER_REF_MAX_ENTRIES: '2000',
      CHAT_IN_FLIGHT_MAX_RUNS: '2',
      CHAT_IN_FLIGHT_MAX_QUEUED: '1',
      CHAT_IN_FLIGHT_RETRY_AFTER_SECONDS: '3',
      CHAT_CONVERSATION_LOCK_TTL_MS: '40000',
      CHAT_CONVERSATION_LOCK_MAX_ENTRIES: '2000',
      CHAT_HTTP_DEADLINE_MS: '40000',
      CHAT_RETENTION_DAYS: '14',
      CHAT_MAX_ACTIVE_CUSTOMER_KEYS_PER_TENANT: '3',
    });

    expect(settings).toEqual({
      historyWindowSize: 5,
      historyMaxChars: 3000,
      maxMessagesPerConversation: 20,
      maxBodyBytes: 16000,
      rateLimitIpMaxRequests: 10,
      rateLimitIpWindowMs: 30000,
      rateLimitIpMaxEntries: 1000,
      rateLimitApiKeyMaxRequests: 30,
      rateLimitApiKeyWindowMs: 30000,
      rateLimitApiKeyMaxEntries: 1000,
      rateLimitTenantMaxRequests: 60,
      rateLimitTenantWindowMs: 30000,
      rateLimitTenantMaxEntries: 300,
      rateLimitCustomerRefMaxRequests: 5,
      rateLimitCustomerRefWindowMs: 30000,
      rateLimitCustomerRefMaxEntries: 2000,
      inFlightMaxRuns: 2,
      inFlightMaxQueued: 1,
      inFlightRetryAfterSeconds: 3,
      conversationLockTtlMs: 40000,
      conversationLockMaxEntries: 2000,
      httpDeadlineMs: 40000,
      retentionDays: 14,
      maxActiveCustomerKeysPerTenant: 3,
    });
  });

  it('throws a clear error on an invalid value rather than silently coercing it', () => {
    expect(() => loadChatSettingsFromEnv({ CHAT_HISTORY_WINDOW_SIZE: 'not-a-number' })).toThrow(/Invalid ChatSettings/);
  });

  it('allows inFlightMaxQueued to be explicitly 0 (no burst allowance)', () => {
    const settings = loadChatSettingsFromEnv({ CHAT_IN_FLIGHT_MAX_QUEUED: '0' });
    expect(settings.inFlightMaxQueued).toBe(0);
  });
});
