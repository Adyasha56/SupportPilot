import { afterEach, describe, expect, it } from 'vitest';
import { ConnectorConfig } from '@supportpilot/shared';
import { ConnectorConfigNotFoundError, ConnectorConfigRepository } from '../../connectors/connector-config.repository';
import { ToolRunnerSettings } from '../tool-runner/tool-runner.settings';
import { startStubServer, StubServer } from '../tool-runner/test-utils/stub-server';
import { ReadOnlyToolRunner } from './read-only-tool-runner';

const TEST_TOKEN = 'test-token-value';

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

function makeConfig(baseUrl: string, overrides: Partial<ConnectorConfig> = {}): ConnectorConfig {
  return {
    tenantId: 'acme',
    tool: 'get_order',
    description: 'test',
    inputSchema: { order_id: 'string' },
    request: {
      method: 'GET',
      baseUrl,
      path: '/x/{order_id}',
      auth: { type: 'bearer', secretRef: 'CONNECTOR_SECRET_TEST_TOKEN' },
    },
    responseMap: {},
    riskLevel: 'low',
    ...overrides,
  };
}

function makeSettings(port: number): ToolRunnerSettings {
  return {
    hostAllowlist: [`127.0.0.1:${port}`],
    allowPrivateNetworks: true,
    requestTimeoutMs: 300,
    maxResponseBytes: 10_000,
    requireHttps: false,
  };
}

const secretProvider = (ref: string): string | undefined => (ref === 'CONNECTOR_SECRET_TEST_TOKEN' ? TEST_TOKEN : undefined);

describe('ReadOnlyToolRunner', () => {
  let server: StubServer | undefined;

  afterEach(async () => {
    await server?.close();
    server = undefined;
  });

  it('runs a low-risk tool through to the real upstream', async () => {
    let requestCount = 0;
    server = await startStubServer((_req, res) => {
      requestCount += 1;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status: 'delivered', total: 49.99, placedAt: '2026-01-01T00:00:00.000Z', customerRef: 'cust_1' }));
    });

    const runner = new ReadOnlyToolRunner({
      repository: new InMemoryRepository([
        makeConfig(server.url, {
          tool: 'get_order',
          riskLevel: 'low',
          responseMap: { status: '$.status', total: '$.total', placedAt: '$.placedAt', customerRef: '$.customerRef' },
        }),
      ]),
      settings: makeSettings(server.port),
      secretProvider,
      resolveDns: async () => ['127.0.0.1'],
    });

    const result = await runner.run('acme', 'get_order', { order_id: 'ORD-1001' });

    expect(result.ok).toBe(true);
    expect(requestCount).toBe(1);
  });

  it('NEVER sends a single request for a riskLevel:"high" connector (issue_refund)', async () => {
    let requestCount = 0;
    server = await startStubServer((_req, res) => {
      requestCount += 1;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{}');
    });

    const runner = new ReadOnlyToolRunner({
      repository: new InMemoryRepository([
        makeConfig(server.url, { tool: 'issue_refund', riskLevel: 'high', inputSchema: { order_id: 'string', amount: 'number' } }),
      ]),
      settings: makeSettings(server.port),
      secretProvider,
      resolveDns: async () => ['127.0.0.1'],
    });

    const result = await runner.run('acme', 'issue_refund', { order_id: 'ORD-1001', amount: 10 });

    expect(result).toEqual({ ok: false, error: { code: 'BLOCKED_BY_POLICY', message: expect.any(String) } });
    expect(requestCount).toBe(0);
  });

  it('NEVER sends a request for a get_order/track_shipment connector a tenant has misconfigured as riskLevel:"high"', async () => {
    let requestCount = 0;
    server = await startStubServer((_req, res) => {
      requestCount += 1;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{}');
    });

    const runner = new ReadOnlyToolRunner({
      repository: new InMemoryRepository([makeConfig(server.url, { tool: 'get_order', riskLevel: 'high' })]),
      settings: makeSettings(server.port),
      secretProvider,
      resolveDns: async () => ['127.0.0.1'],
    });

    const result = await runner.run('acme', 'get_order', { order_id: 'ORD-1001' });

    expect(result).toEqual({ ok: false, error: { code: 'BLOCKED_BY_POLICY', message: expect.any(String) } });
    expect(requestCount).toBe(0);
  });

  it('returns CONFIG_ERROR, never attempting a request, for an unconfigured tool', async () => {
    let requestCount = 0;
    server = await startStubServer((_req, res) => {
      requestCount += 1;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{}');
    });

    const runner = new ReadOnlyToolRunner({
      repository: new InMemoryRepository([]),
      settings: makeSettings(server.port),
      secretProvider,
      resolveDns: async () => ['127.0.0.1'],
    });

    const result = await runner.run('acme', 'get_order', { order_id: 'ORD-1001' });

    expect(result).toEqual({ ok: false, error: { code: 'CONFIG_ERROR', message: expect.any(String) } });
    expect(requestCount).toBe(0);
  });
});
