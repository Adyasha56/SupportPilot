import { afterEach, describe, expect, it, vi } from 'vitest';
import { sendToolHttpRequest } from './http-client';
import { ToolRunnerSettings } from './tool-runner.settings';
import { startStubServer, StubServer } from './test-utils/stub-server';

function makeSettings(overrides: Partial<ToolRunnerSettings> = {}): ToolRunnerSettings {
  return {
    hostAllowlist: ['127.0.0.1'],
    allowPrivateNetworks: true, // stub server is loopback; test-env settings allow it
    requestTimeoutMs: 300,
    maxResponseBytes: 1000,
    requireHttps: false,
    ...overrides,
  };
}

describe('sendToolHttpRequest', () => {
  let server: StubServer | undefined;

  afterEach(async () => {
    await server?.close();
    server = undefined;
  });

  it('returns a successful response', async () => {
    server = await startStubServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
    });

    const outcome = await sendToolHttpRequest({
      url: new URL(server.url),
      method: 'GET',
      headers: {},
      settings: makeSettings(),
      resolveDns: async () => ['127.0.0.1'],
    });

    expect(outcome.kind).toBe('success');
    if (outcome.kind === 'success') {
      expect(outcome.status).toBe(200);
      expect(outcome.body.toString('utf-8')).toBe('{"ok":true}');
    }
  });

  it('times out when the server never responds', async () => {
    server = await startStubServer(() => {
      // Never calls res.end() - simulates a hung upstream.
    });

    const outcome = await sendToolHttpRequest({
      url: new URL(server.url),
      method: 'GET',
      headers: {},
      settings: makeSettings({ requestTimeoutMs: 100 }),
      resolveDns: async () => ['127.0.0.1'],
    });

    expect(outcome.kind).toBe('timeout');
  });

  it('refuses to follow a redirect', async () => {
    server = await startStubServer((_req, res) => {
      res.writeHead(302, { location: 'http://evil.example/' });
      res.end();
    });

    const outcome = await sendToolHttpRequest({
      url: new URL(server.url),
      method: 'GET',
      headers: {},
      settings: makeSettings(),
      resolveDns: async () => ['127.0.0.1'],
    });

    expect(outcome.kind).toBe('redirect-refused');
  });

  it('enforces the byte limit from actual streamed bytes, not a declared Content-Length', async () => {
    // A response that claims to be bigger than it is (content-length: 5,
    // body shorter) is actually rejected by Node's own HTTP parser as a
    // protocol violation if MORE bytes than declared arrive - verified
    // directly. The real gap our own streaming counter defends against is
    // the opposite situation: no Content-Length at all (chunked encoding),
    // where Node has nothing to pre-validate against and our count is the
    // only thing standing between an oversized body and unbounded memory use.
    server = await startStubServer((_req, res) => {
      res.writeHead(200); // no content-length -> chunked transfer-encoding
      res.write('x'.repeat(2000));
      res.end();
    });

    const outcome = await sendToolHttpRequest({
      url: new URL(server.url),
      method: 'GET',
      headers: {},
      settings: makeSettings({ maxResponseBytes: 100 }),
      resolveDns: async () => ['127.0.0.1'],
    });

    expect(outcome.kind).toBe('response-too-large');
  });

  it('runs the DNS lookup on every request, not just the first', async () => {
    // Must target a HOSTNAME, not a literal IP: Node's http client skips
    // invoking `lookup` entirely when the target is already an IP literal
    // (there's no resolution step, so no rebinding window to protect against
    // in the first place) - confirmed directly before relying on it here.
    server = await startStubServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{}');
    });

    const resolveDns = vi.fn(async () => ['127.0.0.1']);
    const settings = makeSettings();
    const url = new URL(`http://my-stub-host.test:${server.port}/`);

    await sendToolHttpRequest({ url, method: 'GET', headers: {}, settings, resolveDns });
    await sendToolHttpRequest({ url, method: 'GET', headers: {}, settings, resolveDns });

    expect(resolveDns).toHaveBeenCalledTimes(2);
  });
});
