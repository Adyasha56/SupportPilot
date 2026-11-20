import { Provider } from '@nestjs/common';
import { RateLimiter } from '../auth/rate-limiter';
import { CHAT_SETTINGS } from './chat-settings.provider';
import { ChatSettings } from './chat.settings';

/**
 * Milestone 5, Stage 1a, amendment A6 - keyed by conversationId
 * (conversation-messages.controller.ts), checked BEFORE the conversation is
 * even looked up, same "cheap check before any real read" ordering
 * ApiKeyGuard's own per-IP limiter already follows. Separate instance from
 * every chat limiter (TENANT_RATE_LIMITER etc.) - polling volume must never
 * share a budget with, or be throttled by, actual chat-sending volume.
 */
export const POLL_RATE_LIMITER = Symbol('POLL_RATE_LIMITER');

export const pollRateLimiterProvider: Provider = {
  provide: POLL_RATE_LIMITER,
  inject: [CHAT_SETTINGS],
  useFactory: (settings: ChatSettings) =>
    new RateLimiter(
      { maxRequests: settings.pollRateLimitMaxRequests, windowMs: settings.pollRateLimitWindowMs, maxEntries: settings.pollRateLimitMaxEntries },
      () => new Date(),
    ),
};
