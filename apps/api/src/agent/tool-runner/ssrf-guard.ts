import { BlockList, isIP } from 'node:net';
import { lookup } from 'node:dns/promises';
import { ToolRunnerSettings } from './tool-runner.settings';

export class SsrfGuardError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SsrfGuardError';
  }
}

export type DnsResolver = (hostname: string) => Promise<string[]>;

export const realDnsResolver: DnsResolver = async (hostname) => {
  const results = await lookup(hostname, { all: true });
  return results.map((result) => result.address);
};

/**
 * Private/loopback/link-local ranges. node:net's BlockList normalizes
 * IPv4-mapped IPv6 addresses internally: checking "::ffff:127.0.0.1" with
 * type "ipv6" against a 127.0.0.0/8 rule added as type "ipv4" correctly
 * returns true, while "::ffff:8.8.8.8" (a public address in mapped form)
 * correctly returns false. Verified directly before relying on it - no
 * manual "::ffff:" stripping needed.
 */
function buildBlockList(): BlockList {
  const blockList = new BlockList();

  blockList.addSubnet('0.0.0.0', 8, 'ipv4');
  blockList.addSubnet('10.0.0.0', 8, 'ipv4');
  blockList.addSubnet('100.64.0.0', 10, 'ipv4');
  blockList.addSubnet('127.0.0.0', 8, 'ipv4');
  blockList.addSubnet('169.254.0.0', 16, 'ipv4');
  blockList.addSubnet('172.16.0.0', 12, 'ipv4');
  blockList.addSubnet('192.168.0.0', 16, 'ipv4');
  blockList.addSubnet('224.0.0.0', 4, 'ipv4');
  blockList.addSubnet('240.0.0.0', 4, 'ipv4');

  blockList.addAddress('::', 'ipv6');
  blockList.addAddress('::1', 'ipv6');
  blockList.addSubnet('fc00::', 7, 'ipv6');
  blockList.addSubnet('fe80::', 10, 'ipv6');

  return blockList;
}

const PRIVATE_RANGE_BLOCK_LIST = buildBlockList();

export function isBlockedAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) {
    return PRIVATE_RANGE_BLOCK_LIST.check(address, 'ipv4');
  }
  if (family === 6) {
    return PRIVATE_RANGE_BLOCK_LIST.check(address, 'ipv6');
  }
  // Not a recognizable IP literal - treat conservatively as blocked.
  return true;
}

function stripIpv6Brackets(hostname: string): string {
  return hostname.startsWith('[') && hostname.endsWith(']')
    ? hostname.slice(1, -1)
    : hostname;
}

interface AllowlistEntry {
  host: string;
  /** null means "no port specified" - matches only the scheme's default port. */
  port: string | null;
}

/**
 * Allowlist entries are "host" or "host:port" (bracketed IPv6 for the latter,
 * e.g. "[::1]:8080", since a bare IPv6 address already contains colons).
 */
function parseAllowlistEntry(raw: string): AllowlistEntry {
  if (raw.startsWith('[')) {
    const closeIdx = raw.indexOf(']');
    if (closeIdx === -1) {
      return { host: raw, port: null };
    }
    const host = raw.slice(1, closeIdx);
    const rest = raw.slice(closeIdx + 1);
    return { host, port: rest.startsWith(':') ? rest.slice(1) : null };
  }

  const colonCount = (raw.match(/:/g) ?? []).length;
  if (colonCount === 1) {
    const [host, port] = raw.split(':');
    return { host, port };
  }

  // 0 colons (hostname/IPv4), or >1 colons (a bare, unbracketed IPv6 address
  // with no port support) - treat as host-only in both cases.
  return { host: raw, port: null };
}

export interface AssertSafeUrlParams {
  url: URL;
  settings: ToolRunnerSettings;
  resolveDns?: DnsResolver;
}

/**
 * Scheme, credentials, and allowlist checks always run, regardless of
 * allowPrivateNetworks - that flag bypasses ONLY the private-range check
 * below. Redirect handling is a separate concern (the tool runner refuses
 * redirects outright); nothing here weakens that.
 */
export async function assertSafeToolRequestUrl({
  url,
  settings,
  resolveDns = realDnsResolver,
}: AssertSafeUrlParams): Promise<void> {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new SsrfGuardError('Only http and https URLs are allowed');
  }

  if (settings.requireHttps && url.protocol !== 'https:') {
    throw new SsrfGuardError('HTTPS is required');
  }

  if (url.username || url.password) {
    throw new SsrfGuardError('URLs containing credentials are not allowed');
  }

  const hostname = stripIpv6Brackets(url.hostname).toLowerCase();
  const schemeDefaultPort = url.protocol === 'https:' ? '443' : '80';
  const effectivePort = url.port || schemeDefaultPort;

  const isAllowed = settings.hostAllowlist.some((raw) => {
    const entry = parseAllowlistEntry(raw);
    if (entry.host !== hostname) {
      return false;
    }
    return entry.port === null ? effectivePort === schemeDefaultPort : entry.port === effectivePort;
  });

  if (!isAllowed) {
    throw new SsrfGuardError('Host is not in the connector allowlist');
  }

  const isIpLiteral = isIP(hostname) !== 0;
  const addresses = isIpLiteral ? [hostname] : await resolveDns(hostname);

  if (addresses.length === 0) {
    throw new SsrfGuardError('Host did not resolve to any address');
  }

  if (!settings.allowPrivateNetworks) {
    for (const address of addresses) {
      if (isBlockedAddress(address)) {
        throw new SsrfGuardError('Host resolves to a blocked network range');
      }
    }
  }
}
