import { Provider } from '@nestjs/common';
import { loadLlmSettingsFromEnv } from './llm.settings';

export const LLM_SETTINGS = Symbol('LLM_SETTINGS');

export const llmSettingsProvider: Provider = {
  provide: LLM_SETTINGS,
  useFactory: () => loadLlmSettingsFromEnv(process.env),
};
