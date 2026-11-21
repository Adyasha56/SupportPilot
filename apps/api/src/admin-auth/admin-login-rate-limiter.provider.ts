import { Provider } from '@nestjs/common';
import { RateLimiter } from '../auth/rate-limiter';
import { ADMIN_AUTH_SETTINGS } from './admin-auth-settings.provider';
import { AdminAuthSettings } from './admin-auth.settings';

export const ADMIN_LOGIN_IP_RATE_LIMITER = Symbol('ADMIN_LOGIN_IP_RATE_LIMITER');

/** Item 3 - per-IP, separate from the per-credential lockout (lockout.ts) - a flood against many DIFFERENT emails from one IP is a different attack than many attempts against one. */
export const adminLoginRateLimiterProvider: Provider = {
  provide: ADMIN_LOGIN_IP_RATE_LIMITER,
  inject: [ADMIN_AUTH_SETTINGS],
  useFactory: (settings: AdminAuthSettings) =>
    new RateLimiter(
      { maxRequests: settings.loginIpRateLimitMaxRequests, windowMs: settings.loginIpRateLimitWindowMs, maxEntries: settings.loginIpRateLimitMaxEntries },
      () => new Date(),
    ),
};
