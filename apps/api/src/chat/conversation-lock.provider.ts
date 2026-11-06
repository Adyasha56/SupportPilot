import { Provider } from '@nestjs/common';
import { ConversationLock } from './conversation-lock';
import { CHAT_SETTINGS } from './chat-settings.provider';
import { ChatSettings } from './chat.settings';

export const CONVERSATION_LOCK = Symbol('CONVERSATION_LOCK');

export const conversationLockProvider: Provider = {
  provide: CONVERSATION_LOCK,
  inject: [CHAT_SETTINGS],
  useFactory: (settings: ChatSettings) =>
    new ConversationLock({ ttlMs: settings.conversationLockTtlMs, maxEntries: settings.conversationLockMaxEntries }, () => new Date()),
};
