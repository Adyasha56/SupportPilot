import { Provider } from '@nestjs/common';
import { DisabledConnectorConfigRepository, FileConnectorConfigRepository } from './connector-config.repository';
import { ConnectorConfigSettings, loadConnectorConfigSettingsFromEnv } from './connector-config.settings';

export const CONNECTOR_CONFIG_SETTINGS = Symbol('CONNECTOR_CONFIG_SETTINGS');
export const CONNECTOR_CONFIG_REPOSITORY = Symbol('CONNECTOR_CONFIG_REPOSITORY');

/**
 * useFactory runs during Nest's DI container initialization - an invalid
 * CONNECTOR_CONFIG_DIR value (not a string) fails bootstrap immediately,
 * same reasoning as every other *SettingsProvider in this project.
 */
export const connectorConfigSettingsProvider: Provider = {
  provide: CONNECTOR_CONFIG_SETTINGS,
  useFactory: () => loadConnectorConfigSettingsFromEnv(process.env),
};

/**
 * No default path, deliberately - see connector-config.settings.ts's doc
 * comment. An unset CONNECTOR_CONFIG_DIR wires in
 * DisabledConnectorConfigRepository rather than guessing a path (the old
 * behavior guessed `process.cwd()/src/connectors/fixtures`, which only
 * ever worked because the production Docker image used to ship that
 * source directory alongside dist/ for exactly this reason - no longer
 * true, see apps/api/package.json's "files" field and docs/learning-notes.md).
 */
export const connectorConfigRepositoryProvider: Provider = {
  provide: CONNECTOR_CONFIG_REPOSITORY,
  inject: [CONNECTOR_CONFIG_SETTINGS],
  useFactory: (settings: ConnectorConfigSettings) => {
    if (!settings.connectorConfigDir) {
      return new DisabledConnectorConfigRepository();
    }
    return new FileConnectorConfigRepository(settings.connectorConfigDir);
  },
};
