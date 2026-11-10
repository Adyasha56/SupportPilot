import { describe, expect, it, vi } from 'vitest';
import { PrivilegedRefundRunner } from './privileged-refund-runner';
import { ApprovalRecord } from './approval.repository';
import { ToolRunResult } from '../agent/tool-runner/tool-runner';
import { ToolRunnerService } from '../agent/tool-runner/tool-runner.service';

function fakeToolRunnerService(
  run: ReturnType<typeof vi.fn<(tenantId: string, toolName: string, args: Record<string, unknown>) => Promise<ToolRunResult>>> = vi.fn(async () => ({ ok: true, data: { status: 'refunded' }, riskLevel: 'high' })),
) {
  return { run } as unknown as ToolRunnerService;
}

function approval(overrides: Partial<ApprovalRecord> = {}): ApprovalRecord {
  return {
    id: 'apr_1',
    tenantId: 'acme',
    runId: 'run_1',
    conversationId: 'conv_1',
    orderId: 'ORD-1001',
    customerRef: 'cust_1',
    amountCents: 4999,
    citations: ['d1-0'],
    status: 'executing',
    retryable: null,
    active: true,
    upstreamMaybeReceived: null,
    failureClass: null,
    verifierVerdictAtProposal: [],
    verifierVerdictAtDecision: null,
    idempotencyKey: 'apr_apr_1',
    attemptCount: 1,
    executionStartedAt: new Date(),
    executingSince: new Date(),
    decidedBy: null,
    decidedAt: null,
    reasonCode: null,
    executionResultCode: null,
    expiresAt: new Date(),
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

describe('PrivilegedRefundRunner', () => {
  it('calls issue_refund with args built ONLY from the Approval record\'s own stored fields', async () => {
    const run = vi.fn<(tenantId: string, toolName: string, args: Record<string, unknown>) => Promise<ToolRunResult>>(async () => ({ ok: true, data: { status: 'refunded' }, riskLevel: 'high' }));
    const runner = new PrivilegedRefundRunner(fakeToolRunnerService(run));

    await runner.execute(approval({ tenantId: 'acme', orderId: 'ORD-1001', amountCents: 4999, idempotencyKey: 'apr_apr_1' }));

    expect(run).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith('acme', 'issue_refund', { order_id: 'ORD-1001', amount: 49.99, idempotencyKey: 'apr_apr_1' });
  });

  it('never calls any tool other than issue_refund - the tool name is hard-coded, not a parameter', async () => {
    const run = vi.fn<(tenantId: string, toolName: string, args: Record<string, unknown>) => Promise<ToolRunResult>>(async () => ({ ok: true, data: {}, riskLevel: 'low' }));
    const runner = new PrivilegedRefundRunner(fakeToolRunnerService(run));
    await runner.execute(approval());
    expect(run.mock.calls[0][1]).toBe('issue_refund');
  });

  it('asserts the Approval is currently executing - refuses to call for any other status', async () => {
    const run = vi.fn<(tenantId: string, toolName: string, args: Record<string, unknown>) => Promise<ToolRunResult>>();
    const runner = new PrivilegedRefundRunner(fakeToolRunnerService(run));

    await expect(runner.execute(approval({ status: 'pending' }))).rejects.toThrow(/expected "executing"/);
    await expect(runner.execute(approval({ status: 'failed' }))).rejects.toThrow(/expected "executing"/);
    expect(run).not.toHaveBeenCalled();
  });

  it('propagates the real ToolRunResult (success or failure) unchanged', async () => {
    const failure: ToolRunResult = { ok: false, error: { code: 'TIMEOUT', message: 'Upstream request timed out.' } };
    const runner = new PrivilegedRefundRunner(fakeToolRunnerService(vi.fn<(tenantId: string, toolName: string, args: Record<string, unknown>) => Promise<ToolRunResult>>(async () => failure)));
    const result = await runner.execute(approval());
    expect(result).toEqual(failure);
  });
});
