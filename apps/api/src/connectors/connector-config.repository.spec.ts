import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  ConnectorConfigNotFoundError,
  FileConnectorConfigRepository,
  InvalidConnectorConfigError,
  TenantMismatchError,
} from './connector-config.repository';

const REAL_FIXTURES_ROOT = join(__dirname, 'fixtures');

const VALID_CONFIG = {
  tenantId: 'acme',
  tool: 'get_order',
  description: 'Fetch an order by id',
  inputSchema: { order_id: 'string' },
  request: {
    method: 'GET',
    baseUrl: 'http://localhost:4100',
    path: '/orders/{order_id}',
    auth: { type: 'bearer', secretRef: 'CONNECTOR_SECRET_ACME_MOCK_STORE_TOKEN' },
  },
  responseMap: { status: '$.status' },
  riskLevel: 'low',
};

describe('FileConnectorConfigRepository against the real fixtures', () => {
  const repo = new FileConnectorConfigRepository(REAL_FIXTURES_ROOT);

  it('loads all four acme connector configs', () => {
    const configs = repo.findAllForTenant('acme');
    const tools = configs.map((c) => c.tool).sort();
    expect(tools).toEqual(['escalate_to_human', 'get_order', 'issue_refund', 'track_shipment']);
  });

  it('loads widgetco in isolation from acme', () => {
    const configs = repo.findAllForTenant('widgetco');
    expect(configs).toHaveLength(1);
    expect(configs[0].tool).toBe('get_order');
    expect(configs[0].request.baseUrl).toBe('http://localhost:4200');
  });

  it('never leaks tenant B config when loading tenant A', () => {
    const acmeConfigs = repo.findAllForTenant('acme');
    const acmeSecretRefs = acmeConfigs.map((c) => c.request.auth.secretRef);
    expect(acmeSecretRefs).not.toContain('CONNECTOR_SECRET_WIDGETCO_STORE_TOKEN');
  });

  it('fails to find a tool that does not exist for that tenant', () => {
    expect(() => repo.findByTool('widgetco', 'issue_refund')).toThrow(ConnectorConfigNotFoundError);
  });

  it('fails for a tenant with no fixture directory at all', () => {
    expect(() => repo.findAllForTenant('nonexistent-tenant')).toThrow(ConnectorConfigNotFoundError);
  });
});

describe('FileConnectorConfigRepository path safety and tenant id validation', () => {
  const repo = new FileConnectorConfigRepository(REAL_FIXTURES_ROOT);

  it.each([
    '..',
    '../x',
    '../../etc',
    '/etc/passwd',
    'C:\\Windows\\System32',
    '%2e%2e%2fx',
    '..%2f..%2fetc',
    'Acme', // uppercase not allowed
    '',
    'a'.repeat(33), // over the 32-char cap
  ])('rejects tenantId %j before touching the filesystem', (badTenantId) => {
    expect(() => repo.findAllForTenant(badTenantId)).toThrow(ConnectorConfigNotFoundError);
  });
});

describe('FileConnectorConfigRepository against a scratch fixture tree', () => {
  let scratchRoot: string;

  beforeEach(() => {
    scratchRoot = mkdtempSync(join(tmpdir(), 'connector-config-test-'));
  });

  afterEach(() => {
    rmSync(scratchRoot, { recursive: true, force: true });
  });

  function writeTenantConfig(tenantId: string, filename: string, contents: string): void {
    const dir = join(scratchRoot, tenantId);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, filename), contents, 'utf-8');
  }

  it('rejects malformed JSON', () => {
    writeTenantConfig('acme', 'bad.json', '{not valid json');
    const repo = new FileConnectorConfigRepository(scratchRoot);
    expect(() => repo.findAllForTenant('acme')).toThrow(InvalidConnectorConfigError);
  });

  it('rejects a config that fails schema validation', () => {
    writeTenantConfig('acme', 'bad.json', JSON.stringify({ tool: 'get_order' }));
    const repo = new FileConnectorConfigRepository(scratchRoot);
    expect(() => repo.findAllForTenant('acme')).toThrow(InvalidConnectorConfigError);
  });

  it('rejects an unknown tool name', () => {
    writeTenantConfig(
      'acme',
      'bad.json',
      JSON.stringify({ ...VALID_CONFIG, tool: 'delete_everything' }),
    );
    const repo = new FileConnectorConfigRepository(scratchRoot);
    expect(() => repo.findAllForTenant('acme')).toThrow(InvalidConnectorConfigError);
  });

  it('rejects a config whose tenantId does not match its folder', () => {
    writeTenantConfig('acme', 'config.json', JSON.stringify({ ...VALID_CONFIG, tenantId: 'widgetco' }));
    const repo = new FileConnectorConfigRepository(scratchRoot);
    expect(() => repo.findAllForTenant('acme')).toThrow(TenantMismatchError);
  });

  it('rejects duplicate tool names within one tenant', () => {
    writeTenantConfig('acme', 'a.json', JSON.stringify(VALID_CONFIG));
    writeTenantConfig('acme', 'b.json', JSON.stringify(VALID_CONFIG));
    const repo = new FileConnectorConfigRepository(scratchRoot);
    expect(() => repo.findAllForTenant('acme')).toThrow(InvalidConnectorConfigError);
  });

  it('rejects a config file over the size cap', () => {
    const oversized = {
      ...VALID_CONFIG,
      description: 'x'.repeat(20 * 1024),
    };
    writeTenantConfig('acme', 'big.json', JSON.stringify(oversized));
    const repo = new FileConnectorConfigRepository(scratchRoot);
    expect(() => repo.findAllForTenant('acme')).toThrow(InvalidConnectorConfigError);
  });

  it('ignores non-JSON files in the tenant directory', () => {
    writeTenantConfig('acme', 'config.json', JSON.stringify(VALID_CONFIG));
    writeTenantConfig('acme', 'README.md', '# not a config');
    const repo = new FileConnectorConfigRepository(scratchRoot);
    expect(repo.findAllForTenant('acme')).toHaveLength(1);
  });

  it('rejects a GET connector config that declares a body', () => {
    writeTenantConfig(
      'acme',
      'bad.json',
      JSON.stringify({
        ...VALID_CONFIG,
        request: { ...VALID_CONFIG.request, body: { order_id: 'order_id' } },
      }),
    );
    const repo = new FileConnectorConfigRepository(scratchRoot);
    expect(() => repo.findAllForTenant('acme')).toThrow(InvalidConnectorConfigError);
  });

  it('rejects a POST body mapping that references an unknown input argument', () => {
    const postConfig = {
      ...VALID_CONFIG,
      tool: 'issue_refund',
      inputSchema: { order_id: 'string', amount: 'number' },
      request: {
        method: 'POST',
        baseUrl: 'http://localhost:4100',
        path: '/refunds',
        auth: { type: 'bearer', secretRef: 'CONNECTOR_SECRET_ACME_MOCK_STORE_TOKEN' },
        body: { orderId: 'order_id', total: 'not_a_real_arg' },
      },
    };
    writeTenantConfig('acme', 'bad.json', JSON.stringify(postConfig));
    const repo = new FileConnectorConfigRepository(scratchRoot);
    expect(() => repo.findAllForTenant('acme')).toThrow(InvalidConnectorConfigError);
  });

  it('accepts a POST body mapping whose arguments all exist on the input schema', () => {
    const postConfig = {
      ...VALID_CONFIG,
      tool: 'issue_refund',
      inputSchema: { order_id: 'string', amount: 'number' },
      request: {
        method: 'POST',
        baseUrl: 'http://localhost:4100',
        path: '/refunds',
        auth: { type: 'bearer', secretRef: 'CONNECTOR_SECRET_ACME_MOCK_STORE_TOKEN' },
        body: { orderId: 'order_id', amount: 'amount' },
      },
    };
    writeTenantConfig('acme', 'ok.json', JSON.stringify(postConfig));
    const repo = new FileConnectorConfigRepository(scratchRoot);
    expect(repo.findAllForTenant('acme')).toHaveLength(1);
  });
});
