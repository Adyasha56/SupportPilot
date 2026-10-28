import { Provider } from '@nestjs/common';
import { loadIngestionSettingsFromEnv } from './ingestion.settings';

export const INGESTION_SETTINGS = Symbol('INGESTION_SETTINGS');

export const ingestionSettingsProvider: Provider = {
  provide: INGESTION_SETTINGS,
  useFactory: () => loadIngestionSettingsFromEnv(process.env),
};
