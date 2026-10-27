import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConnectorConfig } from '@supportpilot/shared';
import { ConnectorConfigNotFoundError, ConnectorConfigRepository } from '../../connectors/connector-config.repository';
import { runTool } from './tool-runner';
import { ToolRunnerSettings } from './tool-runner.settings';
import { startStubServer, StubServer } from './test-utils/stub-server';

const TEST_TOKEN = 'test-token-value';
const TEST_CUSTOMER_REF = 'cust_super_secret_42';

class InMemoryRepository implements ConnectorConfigRepository {
  constructor(private readonly configs: ConnectorConfig[]) {}

  findAllForTenant(tenantId: string): ConnectorConfig[] {
    return this.configs.filter((c) => c.tenantId === tenantId);
  }

  findByTool(tenantId: string, tool: string): ConnectorConfig {
    const match = this.configs.find((c) => c.tenantId === tenantId && c.tool === tool);
    if (!match) {
      throw new ConnectorConfigNotFoundError('not found');
    }
    return match;
  }
}

function makeGetOrderConfig(baseUrl: string, overrides: Partial<ConnectorConfig> = {}): ConnectorConfig {
  return {
    tenantId: 'acme',
    tool: 'get_order',
    description: 'Fetch an order',
    inputSchema: { order_id: 'string' },
    request: {
      method: 'GET',
      baseUrl,
      path: '/orders/{order_id}',
      auth: { type: 'bearer', secretRef: 'CONNECTOR_SECRET_TEST_TOKEN' },
    },
    responseMap: {
      status: '$.status',
      total: '$.total',
      placedAt: '$.placedAt',
      customerRef: '$.customerRef',
    },
    riskLevel: 'low',
    ...overrides,
  };
}

function makeSettings(port: number, overrides: Partial<ToolRunnerSettings> = {}): ToolRunnerSettings {
  return {
    hostAllowlist: [`127.0.0.1:${port}`],
    allowPrivateNetworks: true,
    requestTimeoutMs: 300,
    maxResponseBytes: 10_000,
    requireHttps: false,
    ...overrides,
  };
}

const testSecretProvider = (secretRef: string): string | undefined =>
  secretRef === 'CONNECTOR_SECRET_TEST_TOKEN' ? TEST_TOKEN : undefined;

describe('runTool', () => {
  let server: StubServer | undefined;

  afterEach(async () => {
    await server?.close();
    server = undefined;
  });

  it('returns a successful, output-validated result', async () => {
    server = await startStubServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({ status: 'delivered', total: 49.99, placedAt: '2026-01-01T00:00:00.000Z', customerRef: 'cust_1' }),
      );
    });

    const result = await runTool({
      tenantId: 'acme',
      toolName: 'get_order',
      args: { order_id: 'ORD-1001' },
      repository: new InMemoryRepository([makeGetOrderConfig(server.url)]),
      settings: makeSettings(server.port),
      secretProvider: testSecretProvider,
      resolveDns: async () => ['127.0.0.1'],
    });

    expect(result).toEqual({
      ok: true,
      riskLevel: 'low',
      data: { status: 'delivered', total: 49.99, placedAt: '2026-01-01T00:00:00.000Z', customerRef: 'cust_1' },
    });
  });

  it('TIMEOUT when upstream never responds', async () => {
    server = await startStubServer(() => {
      /* never responds */
    });

    const result = await runTool({
      tenantId: 'acme',
      toolName: 'get_order',
      args: { order_id: 'ORD-1001' },
      repository: new InMemoryRepository([makeGetOrderConfig(server.url)]),
      settings: makeSettings(server.port, { requestTimeoutMs: 100 }),
      secretProvider: testSecretProvider,
      resolveDns: async () => ['127.0.0.1'],
    });

    expect(result).toEqual({ ok: false, error: { code: 'TIMEOUT', message: expect.any(String) } });
  });

  it('RESPONSE_TOO_LARGE when the body exceeds the configured limit', async () => {
    server = await startStubServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.write('x'.repeat(2000));
      res.end();
    });

    const result = await runTool({
      tenantId: 'acme',
      toolName: 'get_order',
      args: { order_id: 'ORD-1001' },
      repository: new InMemoryRepository([makeGetOrderConfig(server.url)]),
      settings: makeSettings(server.port, { maxResponseBytes: 100 }),
      secretProvider: testSecretProvider,
      resolveDns: async () => ['127.0.0.1'],
    });

    expect(result).toEqual({ ok: false, error: { code: 'RESPONSE_TOO_LARGE', message: expect.any(String) } });
  });

  it('UPSTREAM_ERROR when upstream attempts a redirect', async () => {
    server = await startStubServer((_req, res) => {
      res.writeHead(302, { location: 'http://evil.example/' });
      res.end();
    });

    const result = await runTool({
      tenantId: 'acme',
      toolName: 'get_order',
      args: { order_id: 'ORD-1001' },
      repository: new InMemoryRepository([makeGetOrderConfig(server.url)]),
      settings: makeSettings(server.port),
      secretProvider: testSecretProvider,
      resolveDns: async () => ['127.0.0.1'],
    });

    expect(result).toEqual({ ok: false, error: { code: 'UPSTREAM_ERROR', message: expect.any(String) } });
  });

  it('INVALID_RESPONSE for a non-JSON content type', async () => {
    server = await startStubServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('{"status":"delivered"}');
    });

    const result = await runTool({
      tenantId: 'acme',
      toolName: 'get_order',
      args: { order_id: 'ORD-1001' },
      repository: new InMemoryRepository([makeGetOrderConfig(server.url)]),
      settings: makeSettings(server.port),
      secretProvider: testSecretProvider,
      resolveDns: async () => ['127.0.0.1'],
    });

    expect(result).toEqual({ ok: false, error: { code: 'INVALID_RESPONSE', message: expect.any(String) } });
  });

  it('INVALID_RESPONSE for malformed JSON', async () => {
    server = await startStubServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{not valid json');
    });

    const result = await runTool({
      tenantId: 'acme',
      toolName: 'get_order',
      args: { order_id: 'ORD-1001' },
      repository: new InMemoryRepository([makeGetOrderConfig(server.url)]),
      settings: makeSettings(server.port),
      secretProvider: testSecretProvider,
      resolveDns: async () => ['127.0.0.1'],
    });

    expect(result).toEqual({ ok: false, error: { code: 'INVALID_RESPONSE', message: expect.any(String) } });
  });

  it('INVALID_RESPONSE when a Content-Encoding header is present', async () => {
    server = await startStubServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json', 'content-encoding': 'gzip' });
      res.end('{"status":"delivered"}');
    });

    const result = await runTool({
      tenantId: 'acme',
      toolName: 'get_order',
      args: { order_id: 'ORD-1001' },
      repository: new InMemoryRepository([makeGetOrderConfig(server.url)]),
      settings: makeSettings(server.port),
      secretProvider: testSecretProvider,
      resolveDns: async () => ['127.0.0.1'],
    });

    expect(result).toEqual({ ok: false, error: { code: 'INVALID_RESPONSE', message: expect.any(String) } });
  });

  it.each([
    [401, 'UPSTREAM_AUTH_FAILED'],
    [404, 'NOT_FOUND'],
    [409, 'CONFLICT'],
    [500, 'UPSTREAM_ERROR'],
  ] as const)('maps HTTP %i to %s', async (status, expectedCode) => {
    server = await startStubServer((_req, res) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end('{}');
    });

    const result = await runTool({
      tenantId: 'acme',
      toolName: 'get_order',
      args: { order_id: 'ORD-1001' },
      repository: new InMemoryRepository([makeGetOrderConfig(server.url)]),
      settings: makeSettings(server.port),
      secretProvider: testSecretProvider,
      resolveDns: async () => ['127.0.0.1'],
    });

    expect(result).toEqual({ ok: false, error: { code: expectedCode, message: expect.any(String) } });
  });

  it('INVALID_RESPONSE when the mapped output fails schema validation', async () => {
    server = await startStubServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      // Missing "total" and "customerRef", required by GetOrderOutputSchema.
      res.end(JSON.stringify({ status: 'delivered', placedAt: '2026-01-01T00:00:00.000Z' }));
    });

    const result = await runTool({
      tenantId: 'acme',
      toolName: 'get_order',
      args: { order_id: 'ORD-1001' },
      repository: new InMemoryRepository([makeGetOrderConfig(server.url)]),
      settings: makeSettings(server.port),
      secretProvider: testSecretProvider,
      resolveDns: async () => ['127.0.0.1'],
    });

    expect(result).toEqual({ ok: false, error: { code: 'INVALID_RESPONSE', message: expect.any(String) } });
  });

  it('sends zero requests and returns SECRET_NOT_CONFIGURED when the secret is unset', async () => {
    let requestCount = 0;
    server = await startStubServer((_req, res) => {
      requestCount += 1;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{}');
    });

    const result = await runTool({
      tenantId: 'acme',
      toolName: 'get_order',
      args: { order_id: 'ORD-1001' },
      repository: new InMemoryRepository([makeGetOrderConfig(server.url)]),
      settings: makeSettings(server.port),
      secretProvider: () => undefined, // unset
      resolveDns: async () => ['127.0.0.1'],
    });

    expect(result).toEqual({ ok: false, error: { code: 'SECRET_NOT_CONFIGURED', message: expect.any(String) } });
    expect(requestCount).toBe(0);
  });

  it('sends exactly one request per call, even on failure', async () => {
    let requestCount = 0;
    server = await startStubServer((_req, res) => {
      requestCount += 1;
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end('{}');
    });

    await runTool({
      tenantId: 'acme',
      toolName: 'get_order',
      args: { order_id: 'ORD-1001' },
      repository: new InMemoryRepository([makeGetOrderConfig(server.url)]),
      settings: makeSettings(server.port),
      secretProvider: testSecretProvider,
      resolveDns: async () => ['127.0.0.1'],
    });

    expect(requestCount).toBe(1);
  });

  it('tenant A cannot run tenant B\'s tool', async () => {
    server = await startStubServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{}');
    });

    const result = await runTool({
      tenantId: 'widgetco', // only "acme" has a config in the repository
      toolName: 'get_order',
      args: { order_id: 'ORD-1001' },
      repository: new InMemoryRepository([makeGetOrderConfig(server.url, { tenantId: 'acme' })]),
      settings: makeSettings(server.port),
      secretProvider: testSecretProvider,
      resolveDns: async () => ['127.0.0.1'],
    });

    expect(result).toEqual({ ok: false, error: { code: 'CONFIG_ERROR', message: expect.any(String) } });
  });

  it('rejects a hostile order_id before sending any request', async () => {
    let requestCount = 0;
    server = await startStubServer((_req, res) => {
      requestCount += 1;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{}');
    });

    const result = await runTool({
      tenantId: 'acme',
      toolName: 'get_order',
      args: { order_id: '../x' },
      repository: new InMemoryRepository([makeGetOrderConfig(server.url)]),
      settings: makeSettings(server.port),
      secretProvider: testSecretProvider,
      resolveDns: async () => ['127.0.0.1'],
    });

    expect(result).toEqual({ ok: false, error: { code: 'INVALID_INPUT', message: expect.any(String) } });
    expect(requestCount).toBe(0);
  });

  it('logs only tenantId, tool, outcome code, and duration - never the token or customerRef', async () => {
    server = await startStubServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          status: 'delivered',
          total: 49.99,
          placedAt: '2026-01-01T00:00:00.000Z',
          customerRef: TEST_CUSTOMER_REF,
        }),
      );
    });

    const logCalls: Array<[string, string, string, number]> = [];
    const logOutcome = vi.fn((t: string, tool: string, code: string, durationMs: number) => {
      logCalls.push([t, tool, code, durationMs]);
    });

    const successResult = await runTool({
      tenantId: 'acme',
      toolName: 'get_order',
      args: { order_id: 'ORD-1001' },
      repository: new InMemoryRepository([makeGetOrderConfig(server.url)]),
      settings: makeSettings(server.port),
      secretProvider: testSecretProvider,
      resolveDns: async () => ['127.0.0.1'],
      logOutcome,
    });
    expect(successResult.ok).toBe(true);

    const failureResult = await runTool({
      tenantId: 'acme',
      toolName: 'get_order',
      args: { order_id: 'ORD-9999' },
      repository: new InMemoryRepository([]), // forces CONFIG_ERROR
      settings: makeSettings(server.port),
      secretProvider: testSecretProvider,
      resolveDns: async () => ['127.0.0.1'],
      logOutcome,
    });
    expect(failureResult.ok).toBe(false);

    expect(logCalls).toHaveLength(2);
    const serializedLogs = JSON.stringify(logCalls);
    expect(serializedLogs).not.toContain(TEST_TOKEN);
    expect(serializedLogs).not.toContain(TEST_CUSTOMER_REF);

    // And the error message itself never echoes the customerRef or token either.
    if (!failureResult.ok) {
      expect(failureResult.error.message).not.toContain(TEST_TOKEN);
      expect(failureResult.error.message).not.toContain(TEST_CUSTOMER_REF);
    }
  });
});
