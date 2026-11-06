import { Provider } from '@nestjs/common';
import { RateLimiter } from '../auth/rate-limiter';
import { CHAT_SETTINGS } from './chat-settings.provider';
import { ChatSettings } from './chat.settings';

/**
 * Stage 4 amendment B - the TENANT and per-verified-CUSTOMER-REF layers.
 * The IP and API-KEY layers are a different, shared concern - they live on
 * ApiKeyGuard itself (see chat-api-key-guard-settings.provider.ts), which
 * runs before the database read that resolves a tenant at all; these two
 * limiters only make sense once tenantId (and, narrower, a verified
 * customerRef) are already known, which is chat.service.ts's own job.
 */
export const TENANT_RATE_LIMITER = Symbol('TENANT_RATE_LIMITER');
export const CUSTOMER_REF_RATE_LIMITER = Symbol('CUSTOMER_REF_RATE_LIMITER');

export const tenantRateLimiterProvider: Provider = {
  provide: TENANT_RATE_LIMITER,
  inject: [CHAT_SETTINGS],
  useFactory: (settings: ChatSettings) =>
    new RateLimiter(
      { maxRequests: settings.rateLimitTenantMaxRequests, windowMs: settings.rateLimitTenantWindowMs, maxEntries: settings.rateLimitTenantMaxEntries },
      () => new Date(),
    ),
};

export const customerRefRateLimiterProvider: Provider = {
  provide: CUSTOMER_REF_RATE_LIMITER,
  inject: [CHAT_SETTINGS],
  useFactory: (settings: ChatSettings) =>
    new RateLimiter(
      {
        maxRequests: settings.rateLimitCustomerRefMaxRequests,
        windowMs: settings.rateLimitCustomerRefWindowMs,
        maxEntries: settings.rateLimitCustomerRefMaxEntries,
      },
      () => new Date(),
    ),
};
