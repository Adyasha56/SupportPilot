import { request as httpRequest, IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import type { LookupFunction } from 'node:net';
import { createValidatingLookup } from './safe-lookup';
import { DnsResolver } from './ssrf-guard';
import { ToolRunnerSettings } from './tool-runner.settings';

export type RawHttpOutcome =
  | { kind: 'success'; status: number; headers: Record<string, string | string[] | undefined>; body: Buffer }
  | { kind: 'timeout' }
  | { kind: 'response-too-large' }
  | { kind: 'redirect-refused' }
  | { kind: 'network-error'; message: string };

export interface SendRequestParams {
  url: URL;
  method: 'GET' | 'POST';
  headers: Record<string, string>;
  body?: string;
  settings: ToolRunnerSettings;
  resolveDns?: DnsResolver;
}

/**
 * Sends exactly one request via node:http/node:https (never fetch - see
 * safe-lookup.ts for why: only http.request's `lookup` option lets us
 * validate the address at the actual connect moment). `agent: false` means
 * a fresh, non-pooled connection per call, so a prior validated connection
 * can never be silently reused for a different, unvalidated target.
 *
 * Redirects are never followed - node:http doesn't auto-follow them, and a
 * 3xx status here is mapped to its own outcome rather than treated as a
 * normal upstream response.
 *
 * The response size limit is enforced by counting actual streamed bytes,
 * not by trusting a Content-Length header (which could lie).
 */
export function sendToolHttpRequest(params: SendRequestParams): Promise<RawHttpOutcome> {
  const { url, method, headers, body, settings, resolveDns } = params;

  return new Promise((resolve) => {
    const requestFn = url.protocol === 'https:' ? httpsRequest : httpRequest;
    const lookup = createValidatingLookup({ settings, resolveDns }) as unknown as LookupFunction;

    let settled = false;
    const settle = (outcome: RawHttpOutcome): void => {
      if (settled) return;
      settled = true;
      resolve(outcome);
    };

    const defaultPort = url.protocol === 'https:' ? 443 : 80;

    const req = requestFn(
      {
        method,
        hostname: url.hostname,
        port: url.port ? Number(url.port) : defaultPort,
        path: url.pathname + url.search,
        headers,
        lookup,
        agent: false,
        timeout: settings.requestTimeoutMs,
        // Node's own default (16KB) - set explicitly so it's a deliberate,
        // documented choice rather than an implicit default.
        maxHeaderSize: 16 * 1024,
      },
      (res: IncomingMessage) => {
        const status = res.statusCode ?? 0;

        if (status >= 300 && status < 400) {
          res.resume();
          settle({ kind: 'redirect-refused' });
          return;
        }

        const chunks: Buffer[] = [];
        let received = 0;
        let tooLarge = false;

        res.on('data', (chunk: Buffer) => {
          if (tooLarge) return;
          received += chunk.length;
          if (received > settings.maxResponseBytes) {
            tooLarge = true;
            res.destroy();
            settle({ kind: 'response-too-large' });
            return;
          }
          chunks.push(chunk);
        });

        res.on('end', () => {
          if (tooLarge) return;
          settle({ kind: 'success', status, headers: res.headers, body: Buffer.concat(chunks) });
        });

        res.on('error', (err: Error) => {
          if (tooLarge) return;
          settle({ kind: 'network-error', message: err.message });
        });
      },
    );

    req.on('timeout', () => {
      req.destroy();
      settle({ kind: 'timeout' });
    });

    req.on('error', (err: Error) => {
      settle({ kind: 'network-error', message: err.message });
    });

    if (body) {
      req.write(body);
    }
    req.end();
  });
}
