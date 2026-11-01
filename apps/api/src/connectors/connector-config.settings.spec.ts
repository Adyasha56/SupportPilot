import { describe, expect, it } from 'vitest';
import { loadConnectorConfigSettingsFromEnv } from './connector-config.settings';

describe('loadConnectorConfigSettingsFromEnv', () => {
  it('leaves connectorConfigDir undefined when CONNECTOR_CONFIG_DIR is not set - no default', () => {
    const settings = loadConnectorConfigSettingsFromEnv({});
    expect(settings.connectorConfigDir).toBeUndefined();
  });

  it('leaves connectorConfigDir undefined when CONNECTOR_CONFIG_DIR is an empty string', () => {
    const settings = loadConnectorConfigSettingsFromEnv({ CONNECTOR_CONFIG_DIR: '' });
    expect(settings.connectorConfigDir).toBeUndefined();
  });

  it('picks up CONNECTOR_CONFIG_DIR when set', () => {
    const settings = loadConnectorConfigSettingsFromEnv({ CONNECTOR_CONFIG_DIR: '/some/path' });
    expect(settings.connectorConfigDir).toBe('/some/path');
  });
});
