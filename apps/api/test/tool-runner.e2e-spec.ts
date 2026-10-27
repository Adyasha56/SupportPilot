import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import { Test, TestingModule } from '@nestjs/testing';
import { createApp } from '@supportpilot/mock-store';
import { ConnectorsModule } from '../src/connectors/connectors.module';
import { CONNECTOR_CONFIG_REPOSITORY } from '../src/connectors/connector-config-repository.provider';
import { FileConnectorConfigRepository } from '../src/connectors/connector-config.repository';
import type { ConnectorConfigRepository } from '../src/connectors/connector-config.repository';
import { ConnectorConfig } from '@supportpilot/shared';
import { ToolRunnerModule } from '../src/agent/tool-runner/tool-runner.module';
import { ToolRunnerService } from '../src/agent/tool-runner/tool-runner.service';
import { TOOL_RUNNER_SETTINGS } from '../src/agent/tool-runner/tool-runner-settings.provider';
import { ToolRunnerSettings } from '../src/agent/tool-runner/tool-runner.settings';

const FIXED_CLOCK = () => new Date('2026-01-15T00:00:00.000Z');
const TEST_TOKEN = 'e2e-test-token';

class BaseUrlOverrideRepository implements ConnectorConfigRepository {
  constructor(
    private readonly inner: ConnectorConfigRepository,
    private readonly baseUrl: string,
  ) {}

  findAllForTenant(tenantId: string): ConnectorConfig[] {
    return this.inner.findAllForTenant(tenantId).map((config) => this.override(config));
  }

  findByTool(tenantId: string, tool: string): ConnectorConfig {
    return this.override(this.inner.findByTool(tenantId, tool));
  }

  private override(config: ConnectorConfig): ConnectorConfig {
    return { ...config, request: { ...config.request, baseUrl: this.baseUrl } };
  }
}

describe('ToolRunnerService via Nest module wiring (e2e)', () => {
  let server: Server;
  let moduleRef: TestingModule;

  beforeAll(async () => {
    const app = createApp({ clock: FIXED_CLOCK, token: TEST_TOKEN });
    server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const address = server.address();
    const port = typeof address === 'object' && address !== null ? address.port : 0;

    const fixturesRoot = `${__dirname}/../src/connectors/fixtures`;
    const repository = new BaseUrlOverrideRepository(
      new FileConnectorConfigRepository(fixturesRoot),
      `http://127.0.0.1:${port}`,
    );
    const settings: ToolRunnerSettings = {
      hostAllowlist: [`127.0.0.1:${port}`],
      allowPrivateNetworks: true,
      requestTimeoutMs: 3000,
      maxResponseBytes: 100_000,
      requireHttps: false,
    };

    moduleRef = await Test.createTestingModule({
      imports: [ConnectorsModule, ToolRunnerModule],
    })
      .overrideProvider(CONNECTOR_CONFIG_REPOSITORY)
      .useValue(repository)
      .overrideProvider(TOOL_RUNNER_SETTINGS)
      .useValue(settings)
      .compile();

    process.env.CONNECTOR_SECRET_ACME_MOCK_STORE_TOKEN = TEST_TOKEN;
  });

  afterAll(async () => {
    delete process.env.CONNECTOR_SECRET_ACME_MOCK_STORE_TOKEN;
    await moduleRef.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('resolves ToolRunnerService through DI and runs get_order against the real mock-store', async () => {
    const service = moduleRef.get(ToolRunnerService);

    const result = await service.run('acme', 'get_order', { order_id: 'ORD-1001' });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data).toMatchObject({ status: 'delivered', total: 49.99 });
    }
  });
});
