import { Provider } from '@nestjs/common';
import { HashConcurrencyLimiter } from './password-hash';
import { ADMIN_AUTH_SETTINGS } from './admin-auth-settings.provider';
import { AdminAuthSettings } from './admin-auth.settings';

export const ADMIN_HASH_CONCURRENCY_LIMITER = Symbol('ADMIN_HASH_CONCURRENCY_LIMITER');

export const hashConcurrencyLimiterProvider: Provider = {
  provide: ADMIN_HASH_CONCURRENCY_LIMITER,
  inject: [ADMIN_AUTH_SETTINGS],
  useFactory: (settings: AdminAuthSettings) => new HashConcurrencyLimiter(settings.hashMaxConcurrency, settings.hashMaxQueueLength),
};
