import type { LookupAddress, LookupOptions } from 'node:dns';
import { isIP } from 'node:net';
import { DnsResolver, isBlockedAddress, realDnsResolver } from './ssrf-guard';
import { ToolRunnerSettings } from './tool-runner.settings';

export class SafeLookupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SafeLookupError';
  }
}

type LookupOneCallback = (err: NodeJS.ErrnoException | null, address: string, family: number) => void;
type LookupAllCallback = (err: NodeJS.ErrnoException | null, addresses: LookupAddress[]) => void;
type LookupCallback = LookupOneCallback | LookupAllCallback;

export interface CreateValidatingLookupParams {
  settings: ToolRunnerSettings;
  resolveDns?: DnsResolver;
}

/**
 * DNS-rebinding defense (design A, chosen over a fetch-only pre-check):
 * passed as http.request/https.request's `lookup` option, so Node calls
 * this at the ACTUAL connect moment, not earlier. Validating the address
 * here - not just once upfront in assertSafeToolRequestUrl - closes the
 * window where DNS could return a different (private) address between an
 * earlier check and the real connection.
 *
 * This only overrides how the hostname resolves to an IP. The hostname
 * itself (request.host / TLS servername) is untouched, so TLS certificate
 * verification still checks the original hostname, not the resolved IP.
 *
 * Node may invoke this with or without `all: true` (returning either one
 * address+family or an array), so both call shapes are handled.
 */
export function createValidatingLookup({
  settings,
  resolveDns = realDnsResolver,
}: CreateValidatingLookupParams) {
  return function validatingLookup(
    hostname: string,
    optionsOrCallback: LookupOptions | LookupCallback,
    maybeCallback?: LookupCallback,
  ): void {
    const isOptionsCallable = typeof optionsOrCallback === 'function';
    const callback = (isOptionsCallable ? optionsOrCallback : maybeCallback) as LookupCallback;
    const options = isOptionsCallable ? {} : optionsOrCallback;
    const wantsAll = options.all === true;

    void resolveValidated(hostname, settings, resolveDns).then(
      (addresses) => {
        if (wantsAll) {
          const results: LookupAddress[] = addresses.map((address) => ({
            address,
            family: isIP(address),
          }));
          (callback as LookupAllCallback)(null, results);
        } else {
          const address = addresses[0];
          (callback as LookupOneCallback)(null, address, isIP(address));
        }
      },
      (err: unknown) => {
        if (wantsAll) {
          (callback as LookupAllCallback)(err as NodeJS.ErrnoException, []);
        } else {
          (callback as LookupOneCallback)(err as NodeJS.ErrnoException, '', 0);
        }
      },
    );
  };
}

async function resolveValidated(
  hostname: string,
  settings: ToolRunnerSettings,
  resolveDns: DnsResolver,
): Promise<string[]> {
  const literalFamily = isIP(hostname);
  const addresses = literalFamily !== 0 ? [hostname] : await resolveDns(hostname);

  if (addresses.length === 0) {
    throw new SafeLookupError('Host did not resolve to any address');
  }

  if (!settings.allowPrivateNetworks) {
    for (const address of addresses) {
      if (isBlockedAddress(address)) {
        throw new SafeLookupError('Host resolves to a blocked network range');
      }
    }
  }

  return addresses;
}
