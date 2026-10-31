import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import { createApp } from '@supportpilot/mock-store';
import { ConnectorConfig } from '@supportpilot/shared';
import { FileConnectorConfigRepository } from '../../connectors/connector-config.repository';
import type { ConnectorConfigRepository } from '../../connectors/connector-config.repository';
import { runTool } from './tool-runner';
import { ToolRunnerSettings } from './tool-runner.settings';

const FIXED_CLOCK = () => new Date('2026-01-15T00:00:00.000Z');
const TEST_TOKEN = 'integration-test-token';

/**
 * Wraps the REAL FileConnectorConfigRepository (reading the actual committed
 * acme fixtures from disk, proving the loader + schema + fixtures work
 * end-to-end) and only overrides request.baseUrl in memory, to point at the
 * ephemeral mock-store instance instead of the fixture's committed
 * "http://localhost:4100". The committed fixtures are never modified.
 */
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

describe('runTool against the real mock-store', () => {
  let server: Server;
  let repository: ConnectorConfigRepository;
  let settings: ToolRunnerSettings;

  const secretProvider = (secretRef: string): string | undefined =>
    secretRef === 'CONNECTOR_SECRET_ACME_MOCK_STORE_TOKEN' ? TEST_TOKEN : undefined;
  const resolveDns = async (): Promise<string[]> => ['127.0.0.1'];

  function run(toolName: string, args: Record<string, unknown>) {
    return runTool({
      tenantId: 'acme',
      toolName,
      args,
      repository,
      settings,
      secretProvider,
      resolveDns,
    });
  }

  beforeAll(async () => {
    const app = createApp({ clock: FIXED_CLOCK, token: TEST_TOKEN });
    server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const address = server.address();
    const port = typeof address === 'object' && address !== null ? address.port : 0;

    const fixturesRoot = `${__dirname}/../../connectors/fixtures`;
    repository = new BaseUrlOverrideRepository(
      new FileConnectorConfigRepository(fixturesRoot),
      `http://127.0.0.1:${port}`,
    );
    settings = {
      hostAllowlist: [`127.0.0.1:${port}`],
      allowPrivateNetworks: true,
      requestTimeoutMs: 3000,
      maxResponseBytes: 100_000,
      requireHttps: false,
    };
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  describe('get_order', () => {
    // total is integer cents (GetOrderOutputSchema converts money to cents
    // at the tool-output boundary - Milestone 3, Stage 2 follow-up), not
    // the mock store's own decimal-dollar wire value.
    it.each([
      ['ORD-1001', 'delivered', 4999],
      ['ORD-1002', 'in_transit', 8950],
      ['ORD-1003', 'delayed', 3200],
      ['ORD-1004', 'delivered', 7525],
      ['ORD-1005', 'refunded', 12000],
      ['ORD-1006', 'delivered', 124900],
      ['ORD-1007', 'cancelled', 6000],
    ])('fetches %s (%s, %d cents)', async (orderId, status, total) => {
      const result = await run('get_order', { order_id: orderId });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data).toMatchObject({ status, total });
      }
    });

    it('ORD-1005 (pre-seeded as already refunded) reports alreadyRefundedTotal in cents, joined from the refund record', async () => {
      const result = await run('get_order', { order_id: 'ORD-1005' });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data).toMatchObject({ alreadyRefundedTotal: 12000 });
      }
    });

    it('an order with no refund reports alreadyRefundedTotal as 0', async () => {
      const result = await run('get_order', { order_id: 'ORD-1001' });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data).toMatchObject({ alreadyRefundedTotal: 0 });
      }
    });

    it('exposes deliveredAt for a delivered order', async () => {
      const result = await run('get_order', { order_id: 'ORD-1001' });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data).toMatchObject({ deliveredAt: expect.any(String) });
      }
    });

    it('omits deliveredAt for an order not yet delivered', async () => {
      const result = await run('get_order', { order_id: 'ORD-1002' });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect((result.data as Record<string, unknown>).deliveredAt).toBeUndefined();
      }
    });

    it("returns data for another customer's order, because the store enforces facts, not ownership", async () => {
      // ORD-1008 belongs to cust_5. get_order has no concept of "who is
      // asking" in Milestone 1 - that's deliberately the agent/verifier's
      // job in a later milestone, not the tool or the store's.
      const result = await run('get_order', { order_id: 'ORD-1008' });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data).toMatchObject({ status: 'delivered', total: 4400, customerRef: 'cust_5' });
      }
    });

    it('returns NOT_FOUND for a nonexistent order', async () => {
      const result = await run('get_order', { order_id: 'ORD-9999' });
      expect(result).toEqual({ ok: false, error: { code: 'NOT_FOUND', message: expect.any(String) } });
    });
  });

  describe('track_shipment', () => {
    it('fetches the shipment for a seeded order', async () => {
      const result = await run('track_shipment', { order_id: 'ORD-1002' });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data).toMatchObject({ status: 'in_transit' });
      }
    });

    it('returns NOT_FOUND for a nonexistent order', async () => {
      const result = await run('track_shipment', { order_id: 'ORD-9999' });
      expect(result).toEqual({ ok: false, error: { code: 'NOT_FOUND', message: expect.any(String) } });
    });
  });

  describe('issue_refund', () => {
    it('issues a refund for a valid order and amount (happy path)', async () => {
      const result = await run('issue_refund', { order_id: 'ORD-1002', amount: 50 });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data).toMatchObject({ orderId: 'ORD-1002', amount: 50, status: 'refunded' });
      }
    });

    it('returns CONFLICT when refunding an order that is already refunded', async () => {
      // ORD-1005 is pre-seeded as already refunded - no mutation needed here.
      const result = await run('issue_refund', { order_id: 'ORD-1005', amount: 120.0 });
      expect(result).toEqual({ ok: false, error: { code: 'CONFLICT', message: expect.any(String) } });
    });

    it('maps "amount exceeds total" (upstream 400) to UPSTREAM_ERROR', async () => {
      const result = await run('issue_refund', { order_id: 'ORD-1003', amount: 999 });
      expect(result).toEqual({ ok: false, error: { code: 'UPSTREAM_ERROR', message: expect.any(String) } });
    });

    it('replays the original result for a repeated idempotencyKey with the same body', async () => {
      const first = await run('issue_refund', {
        order_id: 'ORD-1004',
        amount: 75.25,
        idempotencyKey: 'integration-replay-key',
      });
      expect(first.ok).toBe(true);

      const replay = await run('issue_refund', {
        order_id: 'ORD-1004',
        amount: 75.25,
        idempotencyKey: 'integration-replay-key',
      });
      expect(replay.ok).toBe(true);
      if (first.ok && replay.ok) {
        expect((replay.data as { refundId: string }).refundId).toBe(
          (first.data as { refundId: string }).refundId,
        );
      }
    });

    it('returns CONFLICT when the same idempotencyKey is reused with a different amount', async () => {
      const first = await run('issue_refund', {
        order_id: 'ORD-1006',
        amount: 100,
        idempotencyKey: 'integration-conflict-key',
      });
      expect(first.ok).toBe(true);

      const second = await run('issue_refund', {
        order_id: 'ORD-1006',
        amount: 200,
        idempotencyKey: 'integration-conflict-key',
      });
      expect(second).toEqual({ ok: false, error: { code: 'CONFLICT', message: expect.any(String) } });
    });
  });

  describe('escalate_to_human', () => {
    it('creates an escalation (happy path)', async () => {
      const result = await run('escalate_to_human', { summary: 'Customer needs a human' });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data).toMatchObject({ status: 'created' });
      }
    });
  });
});
