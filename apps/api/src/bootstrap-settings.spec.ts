import { describe, expect, it } from 'vitest';
import { loadBootstrapSettingsFromEnv } from './bootstrap-settings';

describe('loadBootstrapSettingsFromEnv', () => {
  it('defaults trustProxyHops to 0 (trust nothing) when unset', () => {
    expect(loadBootstrapSettingsFromEnv({}).trustProxyHops).toBe(0);
  });

  it('reads TRUST_PROXY_HOPS from env', () => {
    expect(loadBootstrapSettingsFromEnv({ TRUST_PROXY_HOPS: '1' }).trustProxyHops).toBe(1);
  });

  it('rejects a negative value rather than silently clamping it', () => {
    expect(() => loadBootstrapSettingsFromEnv({ TRUST_PROXY_HOPS: '-1' })).toThrow(/Invalid BootstrapSettings/);
  });
});
