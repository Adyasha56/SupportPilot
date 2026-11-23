import { ApiKeyScope } from '../db/schemas/api-key.schema';

/**
 * A RANK comparison, not a set of independent flags (Stage 6, amendment E):
 * `public` = 0, `secret` = 1, `admin` = 2. A key satisfies a route's required scope iff its own
 * highest rank is >= the required rank - `secret` is a strict superset of `public` (PROJECT.md
 * section 6: "a separate secretKey... authorizes all other /v1/* endpoints", which includes the
 * public-only /v1/chat route - Stage 4 amendment I), and `admin` is a strict superset of both
 * (it satisfies every other route too, same as `secret` already does, PLUS the `/v1/approvals*`
 * routes that specifically require it). The reverse never holds in either direction: a
 * `public`-scope key never satisfies `secret` or `admin`, and a `secret`-scope key - despite
 * already working on every OTHER `/v1/*` endpoint - never satisfies `admin`, getting the exact
 * same generic rejection a `public` key does on `/v1/approvals*`. No requirement (`required`
 * undefined) always passes, unchanged from before this stage.
 *
 * Shared by `ApiKeyGuard` (where it originated, Stage 6) and `AdminAuthGuard` (Stage 1c, item 1 -
 * a key principal on the admin surface needs this SAME rank comparison; a session principal
 * never goes through this function at all, since a session always counts as `admin` outright).
 */
export const SCOPE_RANK: Record<ApiKeyScope, number> = { public: 0, secret: 1, admin: 2 };

export function highestScopeRank(keyScopes: ApiKeyScope[]): number {
  return keyScopes.reduce((max, scope) => Math.max(max, SCOPE_RANK[scope]), 0);
}

export function scopeSatisfies(keyScopes: ApiKeyScope[], required: ApiKeyScope): boolean {
  return highestScopeRank(keyScopes) >= SCOPE_RANK[required];
}
