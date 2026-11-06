import { z } from 'zod';

/**
 * Every configurable number this module (Stage 4: persistence + POST
 * /v1/chat) needs, in one validated settings object - same
 * *.settings.ts + env-loader pattern as ingestion.settings.ts,
 * retrieval.settings.ts, and run-agent.settings.ts. Fails fast (throws) on
 * an invalid value present in env; boots with the documented defaults
 * below when a variable is simply unset - never silently different
 * behavior between "unset" and "set to the default value".
 */
export const ChatSettingsSchema = z.object({
  /** How many of a conversation's most recent stored messages are loaded into HistoryTurn[] for runAgent - never truncates what's stored, only what's loaded. */
  historyWindowSize: z.number().int().positive(),
  /** Stage 4 amendment F - the history window is ALSO capped by total characters, on top of the message-count cap above: whichever limit is hit first wins. */
  historyMaxChars: z.number().int().positive(),
  /** Once a conversation's messageCount would exceed this, further requests get 409 CONVERSATION_LENGTH_EXCEEDED before runAgent ever runs. */
  maxMessagesPerConversation: z.number().int().positive(),
  /** Explicit HTTP body size cap for POST /v1/chat - generous over ChatRequestSchema's own 4000-char message cap plus JSON overhead, never relying on a framework default. */
  maxBodyBytes: z.number().int().positive(),

  /** Stage 4 amendment B - runs BEFORE any database read, including the API-key lookup (the very first guard on the route). */
  rateLimitIpMaxRequests: z.number().int().positive(),
  rateLimitIpWindowMs: z.number().int().positive(),
  rateLimitIpMaxEntries: z.number().int().positive(),

  rateLimitApiKeyMaxRequests: z.number().int().positive(),
  rateLimitApiKeyWindowMs: z.number().int().positive(),
  rateLimitApiKeyMaxEntries: z.number().int().positive(),

  rateLimitTenantMaxRequests: z.number().int().positive(),
  rateLimitTenantWindowMs: z.number().int().positive(),
  rateLimitTenantMaxEntries: z.number().int().positive(),

  /** Stage 4 amendment B - a narrower limit for a VERIFIED customer specifically, on top of (never instead of) the IP/key/tenant limits above. */
  rateLimitCustomerRefMaxRequests: z.number().int().positive(),
  rateLimitCustomerRefWindowMs: z.number().int().positive(),
  rateLimitCustomerRefMaxEntries: z.number().int().positive(),

  /** Stage 4 amendment B - see in-flight-run-limiter.ts's own doc comment for the full capacity-math reasoning behind these three numbers. */
  inFlightMaxRuns: z.number().int().positive(),
  inFlightMaxQueued: z.number().int().nonnegative(),
  inFlightRetryAfterSeconds: z.number().int().positive(),

  /** Should stay slightly ABOVE AGENT_TOTAL_DEADLINE_MS (run-agent.settings.ts, default 30000) - see conversation-lock.ts's own doc comment. The default here (35000) is not derived automatically from that other settings file; keep both in sync by hand if either changes. */
  conversationLockTtlMs: z.number().int().positive(),
  conversationLockMaxEntries: z.number().int().positive(),

  /** Defense-in-depth HTTP-level deadline - should likewise stay slightly above AGENT_TOTAL_DEADLINE_MS; runAgent's own AbortController is what actually guarantees termination. */
  httpDeadlineMs: z.number().int().positive(),

  /** Stage 4 amendment E - days of retention before a TTL index expires a Message/AgentRun/Conversation row. Read directly from env by db-ensure-indexes.ts (a standalone script, not part of this DI-based settings object) - kept here too so every chat-related number is documented in one place and in .env.example. */
  retentionDays: z.number().int().positive(),

  maxActiveCustomerKeysPerTenant: z.number().int().positive(),
});
export type ChatSettings = z.infer<typeof ChatSettingsSchema>;

export function loadChatSettingsFromEnv(env: NodeJS.ProcessEnv): ChatSettings {
  const candidate = {
    historyWindowSize: Number(env.CHAT_HISTORY_WINDOW_SIZE ?? 10),
    historyMaxChars: Number(env.CHAT_HISTORY_MAX_CHARS ?? 6000),
    maxMessagesPerConversation: Number(env.CHAT_MAX_MESSAGES_PER_CONVERSATION ?? 50),
    maxBodyBytes: Number(env.CHAT_MAX_BODY_BYTES ?? 32_000),

    rateLimitIpMaxRequests: Number(env.CHAT_RATE_LIMIT_IP_MAX_REQUESTS ?? 20),
    rateLimitIpWindowMs: Number(env.CHAT_RATE_LIMIT_IP_WINDOW_MS ?? 60_000),
    rateLimitIpMaxEntries: Number(env.CHAT_RATE_LIMIT_IP_MAX_ENTRIES ?? 5000),

    rateLimitApiKeyMaxRequests: Number(env.CHAT_RATE_LIMIT_API_KEY_MAX_REQUESTS ?? 60),
    rateLimitApiKeyWindowMs: Number(env.CHAT_RATE_LIMIT_API_KEY_WINDOW_MS ?? 60_000),
    rateLimitApiKeyMaxEntries: Number(env.CHAT_RATE_LIMIT_API_KEY_MAX_ENTRIES ?? 2000),

    rateLimitTenantMaxRequests: Number(env.CHAT_RATE_LIMIT_TENANT_MAX_REQUESTS ?? 120),
    rateLimitTenantWindowMs: Number(env.CHAT_RATE_LIMIT_TENANT_WINDOW_MS ?? 60_000),
    rateLimitTenantMaxEntries: Number(env.CHAT_RATE_LIMIT_TENANT_MAX_ENTRIES ?? 500),

    rateLimitCustomerRefMaxRequests: Number(env.CHAT_RATE_LIMIT_CUSTOMER_REF_MAX_REQUESTS ?? 10),
    rateLimitCustomerRefWindowMs: Number(env.CHAT_RATE_LIMIT_CUSTOMER_REF_WINDOW_MS ?? 60_000),
    rateLimitCustomerRefMaxEntries: Number(env.CHAT_RATE_LIMIT_CUSTOMER_REF_MAX_ENTRIES ?? 5000),

    inFlightMaxRuns: Number(env.CHAT_IN_FLIGHT_MAX_RUNS ?? 3),
    inFlightMaxQueued: Number(env.CHAT_IN_FLIGHT_MAX_QUEUED ?? 2),
    inFlightRetryAfterSeconds: Number(env.CHAT_IN_FLIGHT_RETRY_AFTER_SECONDS ?? 5),

    conversationLockTtlMs: Number(env.CHAT_CONVERSATION_LOCK_TTL_MS ?? 35_000),
    conversationLockMaxEntries: Number(env.CHAT_CONVERSATION_LOCK_MAX_ENTRIES ?? 5000),

    httpDeadlineMs: Number(env.CHAT_HTTP_DEADLINE_MS ?? 35_000),

    retentionDays: Number(env.CHAT_RETENTION_DAYS ?? 30),

    maxActiveCustomerKeysPerTenant: Number(env.CHAT_MAX_ACTIVE_CUSTOMER_KEYS_PER_TENANT ?? 5),
  };

  const result = ChatSettingsSchema.safeParse(candidate);
  if (!result.success) {
    throw new Error(`Invalid ChatSettings: ${result.error.message}`);
  }
  return result.data;
}
