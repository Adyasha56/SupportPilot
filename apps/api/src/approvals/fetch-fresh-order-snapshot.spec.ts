import { describe, expect, it } from 'vitest';
import { fetchFreshOrderSnapshotViaReadOnlyToolRunner, ReadOnlyGetOrderRunner } from './fetch-fresh-order-snapshot';

function fakeRunner(result: { ok: true; data: unknown } | { ok: false; error: { code: string; message: string } }): ReadOnlyGetOrderRunner {
  return { run: async () => result };
}

describe('fetchFreshOrderSnapshotViaReadOnlyToolRunner', () => {
  it('maps a successful get_order into a RefundVerifierOrderSnapshot', async () => {
    const runner = fakeRunner({
      ok: true,
      data: { status: 'delivered', customerRef: 'cust_1', deliveredAt: '2026-01-01T00:00:00.000Z', total: 4999, alreadyRefundedTotal: 0 },
    });

    const result = await fetchFreshOrderSnapshotViaReadOnlyToolRunner(runner, 'acme', 'ORD-1001');

    expect(result).toEqual({
      ok: true,
      snapshot: { status: 'delivered', customerRef: 'cust_1', deliveredAt: '2026-01-01T00:00:00.000Z', totalCents: 4999, alreadyRefundedCents: 0 },
    });
  });

  it('a NOT_FOUND tool-runner code maps to reason: NOT_FOUND', async () => {
    const runner = fakeRunner({ ok: false, error: { code: 'NOT_FOUND', message: 'no such order' } });
    const result = await fetchFreshOrderSnapshotViaReadOnlyToolRunner(runner, 'acme', 'ORD-9999');
    expect(result).toEqual({ ok: false, reason: 'NOT_FOUND' });
  });

  it.each(['TIMEOUT', 'UPSTREAM_ERROR', 'CONFIG_ERROR', 'BLOCKED_BY_POLICY', 'SECRET_NOT_CONFIGURED'])(
    'a %s tool-runner code maps to reason: FETCH_FAILED, never ineligibility',
    async (code) => {
      const runner = fakeRunner({ ok: false, error: { code, message: 'simulated' } });
      const result = await fetchFreshOrderSnapshotViaReadOnlyToolRunner(runner, 'acme', 'ORD-1001');
      expect(result).toEqual({ ok: false, reason: 'FETCH_FAILED' });
    },
  );

  it('an order with no deliveredAt (not yet delivered) omits it, never guesses a value', async () => {
    const runner = fakeRunner({ ok: true, data: { status: 'in_transit', customerRef: 'cust_1', total: 8950, alreadyRefundedTotal: 0 } });
    const result = await fetchFreshOrderSnapshotViaReadOnlyToolRunner(runner, 'acme', 'ORD-1002');
    expect(result.ok && result.snapshot.deliveredAt).toBeUndefined();
  });
});
