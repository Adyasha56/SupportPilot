import { Provider } from '@nestjs/common';
import { ApiKeyGuardSettings } from '../auth/api-key.guard';
import { POLL_API_KEY_GUARD_SETTINGS } from './poll-api-key-guard';
import { CHAT_SETTINGS } from './chat-settings.provider';
import { ChatSettings } from './chat.settings';

/**
 * Part 0, item P1 - PollApiKeyGuard's own settings, entirely independent
 * of chatApiKeyGuardSettingsProvider's (the one ChatController uses). See
 * poll-api-key-guard.ts's own doc comment for why this separation exists.
 */
export const pollApiKeyGuardSettingsProvider: Provider = {
  provide: POLL_API_KEY_GUARD_SETTINGS,
  inject: [CHAT_SETTINGS],
  useFactory: (settings: ChatSettings): ApiKeyGuardSettings => ({
    ipRateLimit: {
      maxRequests: settings.pollGuardIpRateLimitMaxRequests,
      windowMs: settings.pollGuardIpRateLimitWindowMs,
      maxEntries: settings.pollGuardIpRateLimitMaxEntries,
    },
    keyRateLimit: {
      maxRequests: settings.pollGuardApiKeyRateLimitMaxRequests,
      windowMs: settings.pollGuardApiKeyRateLimitWindowMs,
      maxEntries: settings.pollGuardApiKeyRateLimitMaxEntries,
    },
  }),
};
