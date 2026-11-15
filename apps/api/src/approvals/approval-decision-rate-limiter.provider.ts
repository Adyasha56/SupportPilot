import { Provider } from '@nestjs/common';
import { RateLimiter } from '../auth/rate-limiter';

/**
 * Stage 6, item 4 - the decision route (POST /v1/approvals/:id/decision) is rate-limited per
 * apiKeyId, on top of (never instead of) ApiKeyGuard's own per-IP/per-key limiters, which run
 * earlier and apply to every /v1/* route uniformly. A sanity ceiling against a misbehaving admin
 * script hammering the endpoint, never a security boundary - same framing this project already
 * gives every other rate limiter.
 */
export const APPROVAL_DECISION_RATE_LIMITER = Symbol('APPROVAL_DECISION_RATE_LIMITER');

export function loadApprovalDecisionRateLimitFromEnv(env: NodeJS.ProcessEnv): { maxRequests: number; windowMs: number; maxEntries: number } {
  return {
    maxRequests: Number(env.APPROVAL_DECISION_RATE_LIMIT_MAX_REQUESTS ?? 30),
    windowMs: Number(env.APPROVAL_DECISION_RATE_LIMIT_WINDOW_MS ?? 60_000),
    maxEntries: Number(env.APPROVAL_DECISION_RATE_LIMIT_MAX_ENTRIES ?? 1000),
  };
}

export const approvalDecisionRateLimiterProvider: Provider = {
  provide: APPROVAL_DECISION_RATE_LIMITER,
  useFactory: () => new RateLimiter(loadApprovalDecisionRateLimitFromEnv(process.env), () => new Date()),
};
