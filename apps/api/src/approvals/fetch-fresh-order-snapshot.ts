import { GetOrderOutput } from '@supportpilot/shared';
import { FetchFreshOrderSnapshotResult } from './approval.service';

/** The minimal shape this needs from ReadOnlyToolRunner - same "narrow structural interface, not the concrete class" pattern run-agent.ts's own ToolRunnerLike already uses. */
export interface ReadOnlyGetOrderRunner {
  run(tenantId: string, toolName: string, args: Record<string, unknown>): Promise<{ ok: true; data: unknown } | { ok: false; error: { code: string; message: string } }>;
}

/**
 * Stage 6 - the REAL `FetchFreshOrderSnapshot` implementation the admin decision route wires in,
 * through the SAME `ReadOnlyToolRunner` the chat path already uses (riskLevel-gated, defense in
 * depth - `get_order` is the only tool this ever calls). Maps the real `ToolRunResult` into
 * exactly the two cases `ApprovalService.approveFromPending` needs to tell apart:
 * `NOT_FOUND` (the tool runner's own explicit "no such order" code - a genuine, structural
 * ineligibility) versus everything else (`FETCH_FAILED` - a connector/timeout/config problem,
 * where nothing is actually known about the order, so it must never be treated as ineligibility).
 */
export async function fetchFreshOrderSnapshotViaReadOnlyToolRunner(
  toolRunner: ReadOnlyGetOrderRunner,
  tenantId: string,
  orderId: string,
): Promise<FetchFreshOrderSnapshotResult> {
  const result = await toolRunner.run(tenantId, 'get_order', { order_id: orderId });
  if (!result.ok) {
    return result.error.code === 'NOT_FOUND' ? { ok: false, reason: 'NOT_FOUND' } : { ok: false, reason: 'FETCH_FAILED' };
  }
  const output = result.data as GetOrderOutput;
  return {
    ok: true,
    snapshot: {
      status: output.status,
      customerRef: output.customerRef,
      deliveredAt: output.deliveredAt,
      totalCents: output.total,
      alreadyRefundedCents: output.alreadyRefundedTotal,
    },
  };
}
