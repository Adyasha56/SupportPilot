import { z } from 'zod';

/**
 * Milestone 5, Stage 1b, item 8 - every configurable number/flag this
 * module needs, in one validated settings object (the same `*.settings.ts`
 * + env-loader pattern as `chat.settings.ts`/`run-agent.settings.ts`).
 */
export const AdminAuthSettingsSchema = z.object({
  // Item 2 - HashConcurrencyLimiter (password-hash.ts). See that file's own
  // doc comment for the memory math these are sized against.
  hashMaxConcurrency: z.number().int().positive(),
  hashMaxQueueLength: z.number().int().nonnegative(),

  // Item 5 - session lifetimes.
  sessionAbsoluteLifetimeMs: z.number().int().positive(),
  sessionIdleTimeoutMs: z.number().int().positive(),
  /** How often lastSeenAt is actually written - "at most once per minute" (item 5), never on every request. */
  sessionLastSeenWriteIntervalMs: z.number().int().positive(),

  // Item 3 - lockout schedule (lockout.ts). freeAttempts failures are
  // ordinary (no lock); each one after that locks for baseMs * 2^n, capped.
  lockoutFreeAttempts: z.number().int().nonnegative(),
  lockoutBaseMs: z.number().int().positive(),
  lockoutCapMs: z.number().int().positive(),

  // Item 3 - per-IP limiter on the login route itself, separate from the
  // per-credential lockout above (a flood against MANY different emails
  // from one IP is a different attack than many attempts against ONE).
  loginIpRateLimitMaxRequests: z.number().int().positive(),
  loginIpRateLimitWindowMs: z.number().int().positive(),
  loginIpRateLimitMaxEntries: z.number().int().positive(),

  // Item 3 - cookie mode. BOTH required for the non-Secure dev cookie to
  // ever be issued (admin-session-cookie.ts) - never either alone.
  devCookieEnabled: z.boolean(),

  // Item 4 - defense in depth for cookie-authenticated state changes:
  // the exact origin(s) this server itself is served from, for the
  // Origin-header check. Empty (the default when unset) means the check
  // can never pass, so cookie-authenticated non-GET requests are refused
  // until this is actually configured - fails closed, never open.
  allowedOrigins: z.array(z.string()),
});
export type AdminAuthSettings = z.infer<typeof AdminAuthSettingsSchema>;

function parseOrigins(raw: string | undefined): string[] {
  return (raw ?? '')
    .split(',')
    .map((o) => o.trim())
    .filter((o) => o.length > 0);
}

export function loadAdminAuthSettingsFromEnv(env: NodeJS.ProcessEnv): AdminAuthSettings {
  const candidate = {
    hashMaxConcurrency: Number(env.ADMIN_HASH_MAX_CONCURRENCY ?? 4),
    hashMaxQueueLength: Number(env.ADMIN_HASH_MAX_QUEUE_LENGTH ?? 20),

    sessionAbsoluteLifetimeMs: Number(env.ADMIN_SESSION_ABSOLUTE_LIFETIME_MS ?? 8 * 60 * 60 * 1000),
    sessionIdleTimeoutMs: Number(env.ADMIN_SESSION_IDLE_TIMEOUT_MS ?? 30 * 60 * 1000),
    sessionLastSeenWriteIntervalMs: Number(env.ADMIN_SESSION_LAST_SEEN_WRITE_INTERVAL_MS ?? 60_000),

    lockoutFreeAttempts: Number(env.ADMIN_LOCKOUT_FREE_ATTEMPTS ?? 3),
    lockoutBaseMs: Number(env.ADMIN_LOCKOUT_BASE_MS ?? 1_000),
    lockoutCapMs: Number(env.ADMIN_LOCKOUT_CAP_MS ?? 15 * 60 * 1000),

    loginIpRateLimitMaxRequests: Number(env.ADMIN_LOGIN_IP_RATE_LIMIT_MAX_REQUESTS ?? 20),
    loginIpRateLimitWindowMs: Number(env.ADMIN_LOGIN_IP_RATE_LIMIT_WINDOW_MS ?? 60_000),
    loginIpRateLimitMaxEntries: Number(env.ADMIN_LOGIN_IP_RATE_LIMIT_MAX_ENTRIES ?? 5000),

    devCookieEnabled: env.ADMIN_DEV_COOKIE_ENABLED === 'true',

    allowedOrigins: parseOrigins(env.ADMIN_ALLOWED_ORIGINS),
  };

  const result = AdminAuthSettingsSchema.safeParse(candidate);
  if (!result.success) {
    throw new Error(`Invalid AdminAuthSettings: ${result.error.message}`);
  }
  return result.data;
}
