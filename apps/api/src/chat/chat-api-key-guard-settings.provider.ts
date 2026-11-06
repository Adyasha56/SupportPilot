import { Provider } from '@nestjs/common';
import { ApiKeyGuardSettings, API_KEY_GUARD_SETTINGS } from '../auth/api-key.guard';
import { CHAT_SETTINGS } from './chat-settings.provider';
import { ChatSettings } from './chat.settings';

/**
 * ChatModule provides its OWN ApiKeyGuard instance (not AuthModule's) so
 * this route's IP/key rate limits can be sized for a public-facing widget
 * (ChatSettings's rateLimitIp... and rateLimitApiKey... fields, Stage 4 amendment B) without
 * changing the numbers every other /v1/* route uses via AuthModule's
 * DEFAULT_API_KEY_GUARD_SETTINGS. The two guard instances hold independent
 * limiter state - a flood against /v1/chat never affects /v1/policies and
 * vice versa.
 */
export const chatApiKeyGuardSettingsProvider: Provider = {
  provide: API_KEY_GUARD_SETTINGS,
  inject: [CHAT_SETTINGS],
  useFactory: (settings: ChatSettings): ApiKeyGuardSettings => ({
    ipRateLimit: { maxRequests: settings.rateLimitIpMaxRequests, windowMs: settings.rateLimitIpWindowMs, maxEntries: settings.rateLimitIpMaxEntries },
    keyRateLimit: { maxRequests: settings.rateLimitApiKeyMaxRequests, windowMs: settings.rateLimitApiKeyWindowMs, maxEntries: settings.rateLimitApiKeyMaxEntries },
  }),
};
