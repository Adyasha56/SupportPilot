import { describe, expect, it } from 'vitest';
import { ConnectorConfigSchema } from '../src/connector-config.schema';

const validConfig = {
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
  responseMap: { status: '$.status', total: '$.total' },
  riskLevel: 'low',
};

describe('ConnectorConfigSchema', () => {
  it('accepts a well-formed config', () => {
    expect(ConnectorConfigSchema.safeParse(validConfig).success).toBe(true);
  });

  it('rejects an unknown tool name', () => {
    const result = ConnectorConfigSchema.safeParse({ ...validConfig, tool: 'delete_everything' });
    expect(result.success).toBe(false);
  });

  it('rejects a non-bearer auth type', () => {
    const result = ConnectorConfigSchema.safeParse({
      ...validConfig,
      request: { ...validConfig.request, auth: { type: 'basic', secretRef: 'x' } },
    });
    expect(result.success).toBe(false);
  });

  it('accepts an optional idPattern override', () => {
    const result = ConnectorConfigSchema.safeParse({ ...validConfig, idPattern: '^ORD-\\d{4,}$' });
    expect(result.success).toBe(true);
  });

  it('rejects a secretRef that does not match CONNECTOR_SECRET_[A-Z0-9_]+', () => {
    const asGeminiKey = ConnectorConfigSchema.safeParse({
      ...validConfig,
      request: { ...validConfig.request, auth: { type: 'bearer', secretRef: 'GEMINI_API_KEY' } },
    });
    expect(asGeminiKey.success).toBe(false);

    const asPath = ConnectorConfigSchema.safeParse({
      ...validConfig,
      request: { ...validConfig.request, auth: { type: 'bearer', secretRef: 'PATH' } },
    });
    expect(asPath.success).toBe(false);
  });

  it('rejects a tenantId with uppercase letters, dots, or over 32 chars', () => {
    expect(ConnectorConfigSchema.safeParse({ ...validConfig, tenantId: 'Acme' }).success).toBe(
      false,
    );
    expect(ConnectorConfigSchema.safeParse({ ...validConfig, tenantId: '..' }).success).toBe(
      false,
    );
    expect(
      ConnectorConfigSchema.safeParse({ ...validConfig, tenantId: 'a'.repeat(33) }).success,
    ).toBe(false);
  });
});
