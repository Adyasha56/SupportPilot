import { Provider } from '@nestjs/common';
import { loadAdminAuthSettingsFromEnv } from './admin-auth.settings';

export const ADMIN_AUTH_SETTINGS = Symbol('ADMIN_AUTH_SETTINGS');

export const adminAuthSettingsProvider: Provider = {
  provide: ADMIN_AUTH_SETTINGS,
  useFactory: () => loadAdminAuthSettingsFromEnv(process.env),
};
