import { describe, expect, it } from 'vitest';
import { loadToolRunnerSettingsFromEnv } from './tool-runner.settings';

function env(overrides: Record<string, string | undefined>): NodeJS.ProcessEnv {
  return { ...overrides } as NodeJS.ProcessEnv;
}

describe('loadToolRunnerSettingsFromEnv', () => {
  it('parses a valid production-like env', () => {
    const settings = loadToolRunnerSettingsFromEnv(
      env({
        NODE_ENV: 'production',
        CONNECTOR_HOST_ALLOWLIST: 'api.acme.example, api.widgetco.example',
      }),
    );
    expect(settings).toEqual({
      hostAllowlist: ['api.acme.example', 'api.widgetco.example'],
      allowPrivateNetworks: false,
      requestTimeoutMs: 5000,
      maxResponseBytes: 1_000_000,
      requireHttps: true,
    });
  });

  it('allows private networks only when NODE_ENV is development or test AND the flag is set', () => {
    const testEnv = loadToolRunnerSettingsFromEnv(
      env({ NODE_ENV: 'test', ALLOW_PRIVATE_NETWORKS: 'true', CONNECTOR_HOST_ALLOWLIST: 'localhost' }),
    );
    expect(testEnv.allowPrivateNetworks).toBe(true);

    const prodEnv = loadToolRunnerSettingsFromEnv(
      env({
        NODE_ENV: 'production',
        ALLOW_PRIVATE_NETWORKS: 'true',
        CONNECTOR_HOST_ALLOWLIST: 'api.acme.example',
      }),
    );
    expect(prodEnv.allowPrivateNetworks).toBe(false);

    const testEnvFlagUnset = loadToolRunnerSettingsFromEnv(
      env({ NODE_ENV: 'test', CONNECTOR_HOST_ALLOWLIST: 'localhost' }),
    );
    expect(testEnvFlagUnset.allowPrivateNetworks).toBe(false);
  });

  it('requires https unless NODE_ENV is development or test', () => {
    expect(
      loadToolRunnerSettingsFromEnv(env({ NODE_ENV: 'production', CONNECTOR_HOST_ALLOWLIST: 'x' }))
        .requireHttps,
    ).toBe(true);
    expect(
      loadToolRunnerSettingsFromEnv(env({ NODE_ENV: 'development', CONNECTOR_HOST_ALLOWLIST: 'x' }))
        .requireHttps,
    ).toBe(false);
    expect(
      loadToolRunnerSettingsFromEnv(env({ NODE_ENV: 'test', CONNECTOR_HOST_ALLOWLIST: 'x' }))
        .requireHttps,
    ).toBe(false);
  });

  it('lowercases and trims the host allowlist', () => {
    const settings = loadToolRunnerSettingsFromEnv(
      env({ NODE_ENV: 'test', CONNECTOR_HOST_ALLOWLIST: ' API.Acme.Example , localhost ' }),
    );
    expect(settings.hostAllowlist).toEqual(['api.acme.example', 'localhost']);
  });

  it('treats an empty host allowlist as valid (blocks all connectors, does not crash)', () => {
    const settings = loadToolRunnerSettingsFromEnv(
      env({ NODE_ENV: 'test', CONNECTOR_HOST_ALLOWLIST: '' }),
    );
    expect(settings.hostAllowlist).toEqual([]);
  });

  it('boots with safe production defaults when no tool-runner env vars are set at all', () => {
    const settings = loadToolRunnerSettingsFromEnv(env({ NODE_ENV: 'production' }));
    expect(settings).toEqual({
      hostAllowlist: [],
      allowPrivateNetworks: false,
      requestTimeoutMs: 5000,
      maxResponseBytes: 1_000_000,
      requireHttps: true,
    });
  });

  it('fails fast on a non-numeric timeout', () => {
    expect(() =>
      loadToolRunnerSettingsFromEnv(
        env({
          NODE_ENV: 'test',
          CONNECTOR_HOST_ALLOWLIST: 'localhost',
          CONNECTOR_REQUEST_TIMEOUT_MS: 'not-a-number',
        }),
      ),
    ).toThrow(/Invalid ToolRunnerSettings/);
  });

  it('respects explicit timeout and response size overrides', () => {
    const settings = loadToolRunnerSettingsFromEnv(
      env({
        NODE_ENV: 'test',
        CONNECTOR_HOST_ALLOWLIST: 'localhost',
        CONNECTOR_REQUEST_TIMEOUT_MS: '2000',
        CONNECTOR_MAX_RESPONSE_BYTES: '500000',
      }),
    );
    expect(settings.requestTimeoutMs).toBe(2000);
    expect(settings.maxResponseBytes).toBe(500000);
  });
});
