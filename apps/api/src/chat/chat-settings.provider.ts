import { Provider } from '@nestjs/common';
import { loadChatSettingsFromEnv } from './chat.settings';

export const CHAT_SETTINGS = Symbol('CHAT_SETTINGS');

export const chatSettingsProvider: Provider = {
  provide: CHAT_SETTINGS,
  useFactory: () => loadChatSettingsFromEnv(process.env),
};
