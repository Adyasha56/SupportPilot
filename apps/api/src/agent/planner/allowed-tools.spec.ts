import { ConnectorConfig } from '@supportpilot/shared';
import { describe, expect, it } from 'vitest';
import { allowedPlannerTools } from './allowed-tools';

function makeConfig(overrides: Partial<ConnectorConfig> = {}): ConnectorConfig {
  return {
    tenantId: 'acme',
    tool: 'get_order',
    description: 'test',
    inputSchema: { order_id: 'string' },
    request: {
      method: 'GET',
      baseUrl: 'http://localhost:4100',
      path: '/orders/{order_id}',
      auth: { type: 'bearer', secretRef: 'CONNECTOR_SECRET_ACME_MOCK_STORE_TOKEN' },
    },
    responseMap: {},
    riskLevel: 'low',
    ...overrides,
  };
}

describe('allowedPlannerTools', () => {
  it('allows get_order and track_shipment when both are configured low-risk', () => {
    const configs = [makeConfig({ tool: 'get_order', riskLevel: 'low' }), makeConfig({ tool: 'track_shipment', riskLevel: 'low' })];
    expect(allowedPlannerTools(configs)).toEqual(new Set(['get_order', 'track_shipment']));
  });

  it('never allows issue_refund, regardless of riskLevel', () => {
    const configs = [makeConfig({ tool: 'issue_refund', riskLevel: 'low' }), makeConfig({ tool: 'issue_refund', riskLevel: 'high' })];
    expect(allowedPlannerTools(configs)).toEqual(new Set());
  });

  it('never allows escalate_to_human', () => {
    const configs = [makeConfig({ tool: 'escalate_to_human', riskLevel: 'low' })];
    expect(allowedPlannerTools(configs)).toEqual(new Set());
  });

  it('excludes a high-risk-flagged get_order or track_shipment connector even though the tool name is eligible', () => {
    const configs = [makeConfig({ tool: 'get_order', riskLevel: 'high' }), makeConfig({ tool: 'track_shipment', riskLevel: 'high' })];
    expect(allowedPlannerTools(configs)).toEqual(new Set());
  });

  it('excludes a tool the tenant never configured at all', () => {
    const configs = [makeConfig({ tool: 'track_shipment', riskLevel: 'low' })];
    expect(allowedPlannerTools(configs)).toEqual(new Set(['track_shipment']));
  });

  it('a full realistic connector set never leaks a high-risk tool into the allowed set', () => {
    const configs = [
      makeConfig({ tool: 'get_order', riskLevel: 'low' }),
      makeConfig({ tool: 'track_shipment', riskLevel: 'low' }),
      makeConfig({ tool: 'issue_refund', riskLevel: 'high' }),
      makeConfig({ tool: 'escalate_to_human', riskLevel: 'low' }),
    ];
    const allowed = allowedPlannerTools(configs);
    expect(allowed).toEqual(new Set(['get_order', 'track_shipment']));
    expect(allowed.has('issue_refund' as never)).toBe(false);
  });

  it('returns an empty set for no configured connectors', () => {
    expect(allowedPlannerTools([])).toEqual(new Set());
  });
});
