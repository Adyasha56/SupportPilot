import { describe, expect, it, vi } from 'vitest';
import { createValidatingLookup, SafeLookupError } from './safe-lookup';
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

describe('createValidatingLookup', () => {
  it('calls back with a single address and family when all is not requested', async () => {
    const lookup = createValidatingLookup({
      settings: makeSettings(),
      resolveDns: resolverReturning('8.8.8.8'),
    });

    const result = await new Promise<[string, number]>((resolve, reject) => {
      lookup('api.acme.example', {}, (err: NodeJS.ErrnoException | null, address: string, family: number) => {
        if (err) reject(err);
        else resolve([address, family]);
      });
    });

    expect(result).toEqual(['8.8.8.8', 4]);
  });

  it('calls back with an array when options.all is true', async () => {
    const lookup = createValidatingLookup({
      settings: makeSettings(),
      resolveDns: resolverReturning('8.8.8.8', '1.1.1.1'),
    });

    const addresses = await new Promise<Array<{ address: string; family: number }>>(
      (resolve, reject) => {
        lookup('api.acme.example', { all: true }, (err: NodeJS.ErrnoException | null, result: Array<{ address: string; family: number }>) => {
          if (err) reject(err);
          else resolve(result);
        });
      },
    );

    expect(addresses).toEqual([
      { address: '8.8.8.8', family: 4 },
      { address: '1.1.1.1', family: 4 },
    ]);
  });

  it('supports the (hostname, callback) overload with no options', async () => {
    const lookup = createValidatingLookup({
      settings: makeSettings(),
      resolveDns: resolverReturning('8.8.8.8'),
    });

    const address = await new Promise<string>((resolve, reject) => {
      lookup('api.acme.example', (err: NodeJS.ErrnoException | null, addr: string) => {
        if (err) reject(err);
        else resolve(addr);
      });
    });

    expect(address).toBe('8.8.8.8');
  });

  it('rejects via the callback when the resolved address is blocked', async () => {
    const lookup = createValidatingLookup({
      settings: makeSettings(),
      resolveDns: resolverReturning('127.0.0.1'),
    });

    const err = await new Promise<NodeJS.ErrnoException | null>((resolve) => {
      lookup('api.acme.example', {}, (callbackErr: NodeJS.ErrnoException | null) => resolve(callbackErr));
    });

    expect(err).toBeInstanceOf(SafeLookupError);
  });

  it('treats the hostname as an IP literal directly, skipping DNS resolution', async () => {
    const resolveDns = vi.fn(async () => {
      throw new Error('resolveDns should not have been called for an IP literal');
    });
    const lookup = createValidatingLookup({ settings: makeSettings(), resolveDns });

    const address = await new Promise<string>((resolve, reject) => {
      lookup('8.8.8.8', {}, (err: NodeJS.ErrnoException | null, addr: string) => {
        if (err) reject(err);
        else resolve(addr);
      });
    });

    expect(address).toBe('8.8.8.8');
    expect(resolveDns).not.toHaveBeenCalled();
  });

  it('allows a loopback address when allowPrivateNetworks is true', async () => {
    const lookup = createValidatingLookup({
      settings: makeSettings({ allowPrivateNetworks: true }),
      resolveDns: resolverReturning('127.0.0.1'),
    });

    const address = await new Promise<string>((resolve, reject) => {
      lookup('api.acme.example', {}, (err: NodeJS.ErrnoException | null, addr: string) => {
        if (err) reject(err);
        else resolve(addr);
      });
    });

    expect(address).toBe('127.0.0.1');
  });
});
