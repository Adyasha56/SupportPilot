import { describe, expect, it, vi } from 'vitest';
import { assertSafeToolRequestUrl, SsrfGuardError } from './ssrf-guard';
import { ToolRunnerSettings } from './tool-runner.settings';

function makeSettings(overrides: Partial<ToolRunnerSettings> = {}): ToolRunnerSettings {
  return {
    hostAllowlist: ['api.acme.example'],
    allowPrivateNetworks: false,
    requestTimeoutMs: 5000,
    maxResponseBytes: 1_000_000,
    requireHttps: true,
    ...overrides,
  };
}

function resolverReturning(...addresses: string[]) {
  return vi.fn(async () => addresses);
}

const BLOCKED_RANGE_CASES: Array<[string, string]> = [
  ['0.0.0.0/8', '0.0.0.1'],
  ['10.0.0.0/8', '10.1.2.3'],
  ['100.64.0.0/10', '100.64.0.1'],
  ['127.0.0.0/8', '127.0.0.1'],
  ['169.254.0.0/16', '169.254.1.1'],
  ['172.16.0.0/12', '172.16.0.1'],
  ['192.168.0.0/16', '192.168.1.1'],
  ['224.0.0.0/4', '224.0.0.1'],
  ['240.0.0.0/4', '240.0.0.1'],
  ['::', '::'],
  ['::1', '::1'],
  ['fc00::/7', 'fc00::1'],
  ['fe80::/10', 'fe80::1'],
];

describe('assertSafeToolRequestUrl - blocked ranges', () => {
  it.each(BLOCKED_RANGE_CASES)('rejects an address in %s (%s)', async (_label, address) => {
    const settings = makeSettings();
    await expect(
      assertSafeToolRequestUrl({
        url: new URL('https://api.acme.example/orders/1'),
        settings,
        resolveDns: resolverReturning(address),
      }),
    ).rejects.toThrow(SsrfGuardError);
  });

  it('rejects an IPv4-mapped IPv6 loopback address', async () => {
    const settings = makeSettings();
    await expect(
      assertSafeToolRequestUrl({
        url: new URL('https://api.acme.example/orders/1'),
        settings,
        resolveDns: resolverReturning('::ffff:127.0.0.1'),
      }),
    ).rejects.toThrow(SsrfGuardError);
  });
});

describe('assertSafeToolRequestUrl - allowed cases', () => {
  it('allows a public address', async () => {
    const settings = makeSettings();
    await expect(
      assertSafeToolRequestUrl({
        url: new URL('https://api.acme.example/orders/1'),
        settings,
        resolveDns: resolverReturning('8.8.8.8'),
      }),
    ).resolves.toBeUndefined();
  });
});

describe('assertSafeToolRequestUrl - allowlist, scheme, and credentials', () => {
  it('rejects a host not in the allowlist, without ever calling DNS', async () => {
    const settings = makeSettings({ hostAllowlist: ['api.acme.example'] });
    const resolveDns = vi.fn(async () => {
      throw new Error('resolveDns should not have been called');
    });
    await expect(
      assertSafeToolRequestUrl({
        url: new URL('https://evil.example/orders/1'),
        settings,
        resolveDns,
      }),
    ).rejects.toThrow(/allowlist/);
    expect(resolveDns).not.toHaveBeenCalled();
  });

  it('rejects a non-http(s) scheme', async () => {
    const settings = makeSettings();
    await expect(
      assertSafeToolRequestUrl({
        url: new URL('ftp://api.acme.example/orders/1'),
        settings,
        resolveDns: resolverReturning('8.8.8.8'),
      }),
    ).rejects.toThrow(/http and https/);
  });

  it('rejects a URL containing credentials', async () => {
    const settings = makeSettings();
    await expect(
      assertSafeToolRequestUrl({
        url: new URL('https://user:pass@api.acme.example/orders/1'),
        settings,
        resolveDns: resolverReturning('8.8.8.8'),
      }),
    ).rejects.toThrow(/credentials/);
  });

  it('rejects http when requireHttps is set', async () => {
    const settings = makeSettings({ requireHttps: true });
    await expect(
      assertSafeToolRequestUrl({
        url: new URL('http://api.acme.example/orders/1'),
        settings,
        resolveDns: resolverReturning('8.8.8.8'),
      }),
    ).rejects.toThrow(/HTTPS is required/);
  });
});

describe('assertSafeToolRequestUrl - multi-address resolution', () => {
  it('rejects when DNS resolves to a mix of public and private addresses', async () => {
    const settings = makeSettings();
    await expect(
      assertSafeToolRequestUrl({
        url: new URL('https://api.acme.example/orders/1'),
        settings,
        resolveDns: resolverReturning('8.8.8.8', '127.0.0.1'),
      }),
    ).rejects.toThrow(SsrfGuardError);
  });
});

describe('assertSafeToolRequestUrl - allowPrivateNetworks', () => {
  it('allows a loopback address when allowPrivateNetworks is true (test-env settings)', async () => {
    const settings = makeSettings({ allowPrivateNetworks: true, requireHttps: false });
    await expect(
      assertSafeToolRequestUrl({
        url: new URL('http://api.acme.example/orders/1'),
        settings,
        resolveDns: resolverReturning('127.0.0.1'),
      }),
    ).resolves.toBeUndefined();
  });

  it('still enforces the allowlist even when allowPrivateNetworks is true', async () => {
    const settings = makeSettings({ allowPrivateNetworks: true, requireHttps: false });
    await expect(
      assertSafeToolRequestUrl({
        url: new URL('http://not-allowlisted.example/orders/1'),
        settings,
        resolveDns: resolverReturning('127.0.0.1'),
      }),
    ).rejects.toThrow(/allowlist/);
  });

  // Whether allowPrivateNetworks=true actually takes effect in production is
  // decided entirely by the settings LOADER (tool-runner.settings.ts), not by
  // this guard, which only ever trusts the boolean it's handed. That
  // NODE_ENV=production forces allowPrivateNetworks to false regardless of
  // the env flag is covered in tool-runner.settings.spec.ts.
});

describe('assertSafeToolRequestUrl - URL normalization of exotic IP forms', () => {
  // The guard takes an already-parsed URL (never a raw string), and reads
  // URL.hostname - so decimal, hex, and bracketed IPv6 forms are normalized
  // by the WHATWG URL parser itself before the guard ever sees them.
  // Verified directly: new URL("http://2130706433/").hostname === "127.0.0.1",
  // and new URL("http://[::ffff:127.0.0.1]/").hostname === "[::ffff:7f00:1]"
  // (the canonical hex form, not the dotted-quad form) - BlockList was
  // confirmed to recognize both textual forms of a mapped address.
  const settings = makeSettings({ hostAllowlist: ['127.0.0.1', '::1'], requireHttps: false });

  it('rejects a decimal IPv4 loopback form (http://2130706433/)', async () => {
    await expect(
      assertSafeToolRequestUrl({
        url: new URL('http://2130706433/'),
        settings,
        resolveDns: resolverReturning('should-not-be-called'),
      }),
    ).rejects.toThrow(SsrfGuardError);
  });

  it('rejects a hex-dotted IPv4 loopback form (http://0x7f.1/)', async () => {
    await expect(
      assertSafeToolRequestUrl({
        url: new URL('http://0x7f.1/'),
        settings,
        resolveDns: resolverReturning('should-not-be-called'),
      }),
    ).rejects.toThrow(SsrfGuardError);
  });

  it('rejects a bracketed IPv6 loopback (http://[::1]/)', async () => {
    await expect(
      assertSafeToolRequestUrl({
        url: new URL('http://[::1]/'),
        settings,
        resolveDns: resolverReturning('should-not-be-called'),
      }),
    ).rejects.toThrow(SsrfGuardError);
  });

  it('rejects a bracketed IPv4-mapped IPv6 loopback (http://[::ffff:127.0.0.1]/)', async () => {
    await expect(
      assertSafeToolRequestUrl({
        url: new URL('http://[::ffff:127.0.0.1]/'),
        settings: makeSettings({ hostAllowlist: ['::ffff:7f00:1'], requireHttps: false }),
        resolveDns: resolverReturning('should-not-be-called'),
      }),
    ).rejects.toThrow(SsrfGuardError);
  });
});

describe('assertSafeToolRequestUrl - host:port allowlist matching', () => {
  it('matches a host:port entry against the exact port', async () => {
    const settings = makeSettings({ hostAllowlist: ['127.0.0.1:4100'], requireHttps: false });
    await expect(
      assertSafeToolRequestUrl({
        url: new URL('http://127.0.0.1:4100/orders/1'),
        settings,
        resolveDns: resolverReturning('127.0.0.1'),
      }),
    ).rejects.toThrow(/blocked network range/); // allowlist passes; private-range check still blocks it
  });

  it('rejects a host:port entry when the request uses a different port', async () => {
    const settings = makeSettings({ hostAllowlist: ['api.acme.example:8443'] });
    await expect(
      assertSafeToolRequestUrl({
        url: new URL('https://api.acme.example:9999/orders/1'),
        settings,
        resolveDns: resolverReturning('8.8.8.8'),
      }),
    ).rejects.toThrow(/allowlist/);
  });

  it('a host-only entry (no port) matches only the scheme default port', async () => {
    const settings = makeSettings({ hostAllowlist: ['api.acme.example'] });

    await expect(
      assertSafeToolRequestUrl({
        url: new URL('https://api.acme.example/orders/1'), // default 443
        settings,
        resolveDns: resolverReturning('8.8.8.8'),
      }),
    ).resolves.toBeUndefined();

    await expect(
      assertSafeToolRequestUrl({
        url: new URL('https://api.acme.example:8443/orders/1'), // non-default
        settings,
        resolveDns: resolverReturning('8.8.8.8'),
      }),
    ).rejects.toThrow(/allowlist/);
  });
});
