import { Provider } from '@nestjs/common';
import { loadRetrievalSettingsFromEnv } from './retrieval.settings';

export const RETRIEVAL_SETTINGS = Symbol('RETRIEVAL_SETTINGS');

export const retrievalSettingsProvider: Provider = {
  provide: RETRIEVAL_SETTINGS,
  useFactory: () => loadRetrievalSettingsFromEnv(process.env),
};
