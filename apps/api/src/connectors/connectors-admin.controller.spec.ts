import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { INestApplication } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AdminAuthGuard } from '../admin-auth/admin-auth.guard';
import { AdminAuthSettings } from '../admin-auth/admin-auth.settings';
import { ADMIN_AUTH_SETTINGS } from '../admin-auth/admin-auth-settings.provider';
import { generateRawApiKey, getKeyPrefix, hashApiKey } from '../auth/api-key.service';
import { API_KEY_REPOSITORY } from '../db/api-key.repository';
import { ADMIN_SESSION_REPOSITORY } from '../db/admin-session.repository';
import { InMemoryApiKeyRepository } from '../db/test-utils/in-memory-api-key.repository';
import { InMemoryAdminSessionRepository } from '../db/test-utils/in-memory-admin-session.repository';
import { ConnectorConfig } from '@supportpilot/shared';
import { ConnectorsAdminController, toConnectorSummary } from './connectors-admin.controller';
import { CONNECTOR_CONFIG_REPOSITORY } from './connector-config-repository.provider';
import { FileConnectorConfigRepository } from './connector-config.repository';

const REAL_FIXTURES_ROOT = join(__dirname, 'fixtures');

function adminAuthSettings(overrides: Partial<AdminAuthSettings> = {}): AdminAuthSettings {
  return {
    hashMaxConcurrency: 6,
    hashMaxQueueLength: 20,
    sessionAbsoluteLifetimeMs: 8 * 60 * 60 * 1000,
    sessionIdleTimeoutMs: 30 * 60 * 1000,
    sessionLastSeenWriteIntervalMs: 60_000,
    lockoutFreeAttempts: 3,
    lockoutBaseMs: 1_000,
    lockoutCapMs: 15 * 60 * 1000,
    loginIpRateLimitMaxRequests: 1000,
    loginIpRateLimitWindowMs: 60_000,
    loginIpRateLimitMaxEntries: 1000,
    devCookieEnabled: false,
    allowedOrigins: [],
    principalRateLimitMaxRequests: 1000,
    principalRateLimitWindowMs: 60_000,
    principalRateLimitMaxEntries: 1000,
    ...overrides,
  };
}

const FULL_CONFIG: ConnectorConfig = {
  tenantId: 'acme',
  tool: 'issue_refund',
  description: 'Issue a refund for an order',
  inputSchema: { order_id: 'string', amount: 'number', idempotencyKey: 'string' },
  request: {
    method: 'POST',
    baseUrl: 'http://localhost:4100',
    path: '/refunds',
    auth: { type: 'bearer', secretRef: 'CONNECTOR_SECRET_ACME_MOCK_STORE_TOKEN' },
    body: { orderId: 'order_id', amount: 'amount', idempotencyKey: 'idempotencyKey' },
  },
  responseMap: { refundId: '$.id' },
  riskLevel: 'high',
  idPattern: '^ORD-\\d{4,}$',
};

describe('toConnectorSummary (Stage 1c, item 4) - pure projection', () => {
  it('keeps only tool and description', () => {
    expect(toConnectorSummary(FULL_CONFIG)).toEqual({ tool: 'issue_refund', description: 'Issue a refund for an order' });
  });

  it('never carries secretRef, the request block, inputSchema, responseMap, riskLevel, or idPattern, even if someone widened the object shape by mistake', () => {
    const summary = toConnectorSummary(FULL_CONFIG) as Record<string, unknown>;
    expect(Object.keys(summary).sort()).toEqual(['description', 'tool']);
    expect(JSON.stringify(summary)).not.toContain('CONNECTOR_SECRET');
    expect(JSON.stringify(summary)).not.toContain('idPattern');
    expect(JSON.stringify(summary)).not.toContain('baseUrl');
  });
});

describe('ConnectorsAdminController (Stage 1c, item 4)', () => {
  let app: INestApplication | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  async function buildApp() {
    const apiKeyRepository = new InMemoryApiKeyRepository();
    const sessionRepository = new InMemoryAdminSessionRepository();
    const connectorConfigRepository = new FileConnectorConfigRepository(REAL_FIXTURES_ROOT);

    const moduleRef = await Test.createTestingModule({
      controllers: [ConnectorsAdminController],
      providers: [
        AdminAuthGuard,
        Reflector,
        { provide: API_KEY_REPOSITORY, useValue: apiKeyRepository },
        { provide: ADMIN_SESSION_REPOSITORY, useValue: sessionRepository },
        { provide: ADMIN_AUTH_SETTINGS, useValue: adminAuthSettings() },
        { provide: CONNECTOR_CONFIG_REPOSITORY, useValue: connectorConfigRepository },
      ],
    }).compile();

    const builtApp = moduleRef.createNestApplication();
    await builtApp.init();

    async function createKey(tenantId: string, scope: 'public' | 'secret' | 'admin' = 'admin') {
      const rawKey = generateRawApiKey();
      await apiKeyRepository.create(tenantId, hashApiKey(rawKey), getKeyPrefix(rawKey), [scope]);
      return rawKey;
    }

    return { app: builtApp, createKey };
  }

  it('lists only tool/description for the real acme fixtures, scoped by tenant', async () => {
    const built = await buildApp();
    app = built.app;
    const rawKey = await built.createKey('acme');

    const res = await request(app.getHttpServer()).get('/v1/connectors').set('Authorization', `Bearer ${rawKey}`);

    expect(res.status).toBe(200);
    const tools = res.body.connectors.map((c: { tool: string }) => c.tool).sort();
    expect(tools).toEqual(['escalate_to_human', 'get_order', 'issue_refund', 'track_shipment']);
  });

  it("never includes secretRef, the request block, inputSchema, responseMap, or idPattern in the real response, for a tool that HAS all of them (issue_refund)", async () => {
    const built = await buildApp();
    app = built.app;
    const rawKey = await built.createKey('acme');

    const res = await request(app.getHttpServer()).get('/v1/connectors').set('Authorization', `Bearer ${rawKey}`);

    const bodyText = JSON.stringify(res.body);
    expect(bodyText).not.toContain('secretRef');
    expect(bodyText).not.toContain('CONNECTOR_SECRET');
    expect(bodyText).not.toContain('baseUrl');
    expect(bodyText).not.toContain('idPattern');
    expect(bodyText).not.toContain('inputSchema');
    expect(bodyText).not.toContain('responseMap');
    expect(bodyText).not.toContain('riskLevel');

    const issueRefund = res.body.connectors.find((c: { tool: string }) => c.tool === 'issue_refund');
    expect(Object.keys(issueRefund).sort()).toEqual(['description', 'tool']);
  });

  it('isolates tenants - widgetco never sees acme\'s connectors', async () => {
    const built = await buildApp();
    app = built.app;
    const rawKey = await built.createKey('widgetco');

    const res = await request(app.getHttpServer()).get('/v1/connectors').set('Authorization', `Bearer ${rawKey}`);

    expect(res.status).toBe(200);
    expect(res.body.connectors).toHaveLength(1);
    expect(res.body.connectors[0].tool).toBe('get_order');
  });

  it('a SECRET-scoped key is rejected - admin is required, same as approvals/conversations/settings', async () => {
    const built = await buildApp();
    app = built.app;
    const rawKey = await built.createKey('acme', 'secret');

    const res = await request(app.getHttpServer()).get('/v1/connectors').set('Authorization', `Bearer ${rawKey}`);
    expect(res.status).toBe(401);
  });

  it('returns an empty list (never an error) for a tenant with no connector fixtures at all', async () => {
    const built = await buildApp();
    app = built.app;
    const rawKey = await built.createKey('no-such-tenant-dir');

    const res = await request(app.getHttpServer()).get('/v1/connectors').set('Authorization', `Bearer ${rawKey}`);
    expect(res.status).toBe(200);
    expect(res.body.connectors).toEqual([]);
  });
});
