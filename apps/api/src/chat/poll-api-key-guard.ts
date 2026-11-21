import { Inject, Injectable, Optional } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ApiKeyGuard, ApiKeyGuardSettings } from '../auth/api-key.guard';
import { API_KEY_REPOSITORY, ApiKeyRepository } from '../db/api-key.repository';
import { TENANT_REPOSITORY, TenantRepository } from '../db/tenant.repository';

export const POLL_API_KEY_GUARD_SETTINGS = Symbol('POLL_API_KEY_GUARD_SETTINGS');

/**
 * Milestone 5, Stage 1a/1b follow-up, Part 0 item P1 - a real bug found
 * while auditing Stage 1a: `ConversationMessagesController` originally
 * shared `ChatController`'s own `ApiKeyGuard` provider. NestJS providers
 * are singletons by default, so "share the provider" means "share the
 * exact same `RateLimiter` instances" - the widget's polling traffic was
 * silently spending the SAME per-IP (20/min) and per-API-key (60/min)
 * budget as chat-SENDING traffic. Two concrete failure modes this caused:
 *   - The per-API-KEY bucket is keyed by the ApiKey document's own id -
 *     and a tenant's public key is ONE document, used by every visitor of
 *     that tenant's widget. 5 concurrent visitors each polling at the old
 *     3s/10s cadence (13 requests/60s each, see poll-rate-limit-headroom.ts)
 *     sum to 65/minute on that ONE shared bucket - already over the 60/min
 *     default, 429-ing every visitor's chat AND polling requests alike,
 *     not just the "excess" ones.
 *   - The per-IP bucket has the identical problem for any set of visitors
 *     who happen to share a NAT'd IP (an office, a university network).
 *
 * The fix: `ConversationMessagesController` gets its OWN `ApiKeyGuard`
 * instance - same class (same header-parsing/key-lookup/scope-check logic,
 * reused via inheritance, not copied), but constructed with its OWN
 * settings token, so its per-IP/per-key `RateLimiter`s are two entirely
 * separate pieces of state from chat's. Same pattern `ChatModule` already
 * uses to differentiate itself from `AuthModule`'s default guard (see
 * chat-api-key-guard-settings.provider.ts's own doc comment) - this is
 * just a second application of it, one level deeper.
 */
@Injectable()
export class PollApiKeyGuard extends ApiKeyGuard {
  constructor(
    @Optional() @Inject(API_KEY_REPOSITORY) repository: ApiKeyRepository | undefined,
    reflector: Reflector,
    @Optional() @Inject(TENANT_REPOSITORY) tenantRepository: TenantRepository | undefined,
    @Optional() @Inject(POLL_API_KEY_GUARD_SETTINGS) settings?: ApiKeyGuardSettings,
  ) {
    super(repository, reflector, tenantRepository, settings);
  }
}
