import { describe, expect, it, vi } from 'vitest';
import { InMemoryApprovalRepository } from '../db/test-utils/in-memory-approval.repository';
import { ApprovalService, CreateFromProposalInput, FetchFreshOrderSnapshot } from './approval.service';
import { PrivilegedRefundRunner } from './privileged-refund-runner';
import { RefundVerifierOrderSnapshot, RefundVerifierTenantSettings } from './refund-verifier';
import { ToolRunResult } from '../agent/tool-runner/tool-runner';

const NOW = new Date('2026-11-09T00:00:00.000Z');

function daysAgo(days: number): Date {
  const d = new Date(NOW);
  d.setUTCDate(d.getUTCDate() - days);
  return d;
}

function orderSnapshot(overrides: Partial<RefundVerifierOrderSnapshot> = {}): RefundVerifierOrderSnapshot {
  return {
    status: 'delivered',
    customerRef: 'cust_1',
    deliveredAt: daysAgo(10).toISOString(),
    totalCents: 10000,
    alreadyRefundedCents: 0,
    ...overrides,
  };
}

function tenantSettings(overrides: Partial<RefundVerifierTenantSettings> = {}): RefundVerifierTenantSettings {
  return {
    refundCap: 2000,
    approvalThreshold: 250,
    refundWindowDays: 30,
    autoExecuteRefunds: false,
    ...overrides,
  };
}

function proposalInput(overrides: Partial<CreateFromProposalInput> = {}): CreateFromProposalInput {
  return {
    tenantId: 'acme',
    runId: 'run_1',
    conversationId: 'conv_1',
    orderId: 'ORD-1001',
    verifiedCustomerRef: 'cust_1',
    amountCents: 5000,
    citations: ['d1-0'],
    orderSnapshot: orderSnapshot(),
    tenantSettings: tenantSettings(),
    approvalExpiryDays: 7,
    customerDailyRefundCount: 0,
    now: NOW,
    ...overrides,
  };
}

/** A fake PrivilegedRefundRunner - cast to the real class type, same pattern used throughout this codebase for narrow structural fakes. */
function fakeRunner(
  execute: (approval: { idempotencyKey: string }) => Promise<ToolRunResult> = async () => ({ ok: true, data: { status: 'refunded' }, riskLevel: 'high' }),
) {
  return { execute } as unknown as PrivilegedRefundRunner;
}

const alwaysFreshOrder: FetchFreshOrderSnapshot = async (_tenantId, _orderId) => orderSnapshot();

describe('ApprovalService.createFromProposal', () => {
  it('denied: a failed rule never creates an Approval row', async () => {
    const repo = new InMemoryApprovalRepository();
    const service = new ApprovalService(repo, fakeRunner());
    const result = await service.createFromProposal(proposalInput({ citations: [] }));

    expect(result.kind).toBe('denied');
    expect(result.kind === 'denied' && result.failedRuleCodes).toEqual(['MISSING_POLICY_CITATION']);
    expect((await repo.list('acme', {})).approvals).toHaveLength(0);
  });

  it('already_pending: a second proposal for an order with an active approval creates no new row', async () => {
    const repo = new InMemoryApprovalRepository();
    const service = new ApprovalService(repo, fakeRunner());
    const first = await service.createFromProposal(proposalInput());
    expect(first.kind).toBe('pending_approval');

    const second = await service.createFromProposal(proposalInput());
    expect(second.kind).toBe('already_pending');
    expect(second.kind === 'already_pending' && second.approvalId).toBe(first.kind === 'pending_approval' ? first.approvalId : undefined);
    expect((await repo.list('acme', {})).approvals).toHaveLength(1);
  });

  it('pending_approval: every rule passes, autoExecuteRefunds is off', async () => {
    const repo = new InMemoryApprovalRepository();
    const service = new ApprovalService(repo, fakeRunner());
    const result = await service.createFromProposal(proposalInput());

    expect(result.kind).toBe('pending_approval');
    expect(result.kind === 'pending_approval' && result.message).toContain('ORD-1001');
    const stored = await repo.findById('acme', (result as { approvalId: string }).approvalId);
    expect(stored?.status).toBe('pending');
  });

  it('auto_executed: success path, autoExecuteRefunds on, amount at or under threshold', async () => {
    const repo = new InMemoryApprovalRepository();
    const run = vi.fn(async () => ({ ok: true as const, data: { status: 'refunded' }, riskLevel: 'high' as const }));
    const service = new ApprovalService(repo, fakeRunner(run));

    const result = await service.createFromProposal(
      proposalInput({ amountCents: 5000, tenantSettings: tenantSettings({ autoExecuteRefunds: true, approvalThreshold: 250 }) }),
    );

    expect(result.kind).toBe('auto_executed');
    expect(result.kind === 'auto_executed' && result.success).toBe(true);
    expect(run).toHaveBeenCalledTimes(1);
    const stored = await repo.findById('acme', (result as { approvalId: string }).approvalId);
    expect(stored?.status).toBe('executed');
  });

  it('auto_executed: AMBIGUOUS failure never claims success, and leaves the Approval failed+retryable', async () => {
    const repo = new InMemoryApprovalRepository();
    const failure: ToolRunResult = { ok: false, error: { code: 'TIMEOUT', message: 'Upstream request timed out.' } };
    const service = new ApprovalService(repo, fakeRunner(async () => failure));

    const result = await service.createFromProposal(
      proposalInput({ amountCents: 5000, tenantSettings: tenantSettings({ autoExecuteRefunds: true, approvalThreshold: 250 }) }),
    );

    expect(result.kind).toBe('auto_executed');
    expect(result.kind === 'auto_executed' && result.success).toBe(false);
    const stored = await repo.findById('acme', (result as { approvalId: string }).approvalId);
    expect(stored?.status).toBe('failed');
    expect(stored?.retryable).toBe(true);
    expect(stored?.active).toBe(true);
  });

  it('auto_executed: the bounded timeout firing never claims success', async () => {
    const repo = new InMemoryApprovalRepository();
    const neverResolves = () => new Promise<ToolRunResult>(() => {}); // hangs forever
    const service = new ApprovalService(repo, fakeRunner(neverResolves), { autoExecuteTimeoutMs: 10 });

    const result = await service.createFromProposal(
      proposalInput({ tenantSettings: tenantSettings({ autoExecuteRefunds: true, approvalThreshold: 250 }) }),
    );

    expect(result.kind).toBe('auto_executed');
    expect(result.kind === 'auto_executed' && result.success).toBe(false);
  }, 2_000);

  it('amendment F2: a stale PENDING row past its own expiry is expired and the insert retried automatically', async () => {
    const repo = new InMemoryApprovalRepository();
    const service = new ApprovalService(repo, fakeRunner());

    const first = await service.createFromProposal(proposalInput({ approvalExpiryDays: 1, now: NOW }));
    expect(first.kind).toBe('pending_approval');

    const wellAfterExpiry = new Date(NOW.getTime() + 2 * 24 * 60 * 60 * 1000);
    const second = await service.createFromProposal(proposalInput({ approvalExpiryDays: 7, now: wellAfterExpiry }));

    expect(second.kind).toBe('pending_approval');
    expect((second as { approvalId: string }).approvalId).not.toBe((first as { approvalId: string }).approvalId);
    const firstRecord = await repo.findById('acme', (first as { approvalId: string }).approvalId);
    expect(firstRecord?.status).toBe('expired');
  });

  it('amendment F2: a genuinely still-active blocking row (not expired) is reported as already_pending, no retry', async () => {
    const repo = new InMemoryApprovalRepository();
    const service = new ApprovalService(repo, fakeRunner());
    const first = await service.createFromProposal(proposalInput({ approvalExpiryDays: 30 }));

    const secondAttempt = await service.createFromProposal(proposalInput({ approvalExpiryDays: 30, now: new Date(NOW.getTime() + 1000) }));
    expect(secondAttempt.kind).toBe('already_pending');
    expect((secondAttempt as { approvalId: string }).approvalId).toBe((first as { approvalId: string }).approvalId);
  });
});

describe('ApprovalService.decide - approve', () => {
  async function proposeAndApprove(repo: InMemoryApprovalRepository, runner: PrivilegedRefundRunner, overrides: Partial<CreateFromProposalInput> = {}) {
    const service = new ApprovalService(repo, runner);
    const proposed = await service.createFromProposal(proposalInput(overrides));
    const approvalId = (proposed as { approvalId: string }).approvalId;
    return { service, approvalId };
  }

  it('a verifier failure on the FIRST attempt denies without ever calling the runner', async () => {
    const repo = new InMemoryApprovalRepository();
    const run = vi.fn(async () => ({ ok: true as const, data: {}, riskLevel: 'high' as const }));
    const { service, approvalId } = await proposeAndApprove(repo, fakeRunner(run));

    // The order is now cancelled by the time an admin looks at it.
    const fetchChangedOrder: FetchFreshOrderSnapshot = async () => orderSnapshot({ status: 'cancelled' });
    const result = await service.decide('acme', approvalId, 'approve', 'key_1', NOW, tenantSettings(), fetchChangedOrder);

    expect(result.ok).toBe(false);
    expect(!result.ok && result.code).toBe('VERIFIER_DENIED');
    expect(run).not.toHaveBeenCalled();
    const stored = await repo.findById('acme', approvalId);
    expect(stored?.status).toBe('failed');
    expect(stored?.retryable).toBe(false);
  });

  it('approve succeeds: executes exactly once, attemptCount 1', async () => {
    const repo = new InMemoryApprovalRepository();
    const run = vi.fn(async () => ({ ok: true as const, data: {}, riskLevel: 'high' as const }));
    const { service, approvalId } = await proposeAndApprove(repo, fakeRunner(run));

    const result = await service.decide('acme', approvalId, 'approve', 'key_1', NOW, tenantSettings(), alwaysFreshOrder);

    expect(result.ok).toBe(true);
    expect(result.ok && result.status).toBe('executed');
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('concurrent double approve: a deterministic gate - exactly one call actually executes the refund', async () => {
    const repo = new InMemoryApprovalRepository();
    const run = vi.fn(async () => ({ ok: true as const, data: {}, riskLevel: 'high' as const }));
    const { service, approvalId } = await proposeAndApprove(repo, fakeRunner(run));

    const [a, b] = await Promise.all([
      service.decide('acme', approvalId, 'approve', 'key_1', NOW, tenantSettings(), alwaysFreshOrder),
      service.decide('acme', approvalId, 'approve', 'key_2', NOW, tenantSettings(), alwaysFreshOrder),
    ]);

    const outcomes = [a, b].map((r) => (r.ok ? r.status : r.code));
    expect(outcomes).toContain('executed');
    expect(outcomes).toContain('IN_PROGRESS');
    expect(run).toHaveBeenCalledTimes(1); // the refund itself only ever happened once
  });

  it('expired approve: EXPIRED, no execution attempt', async () => {
    const repo = new InMemoryApprovalRepository();
    const run = vi.fn(async () => ({ ok: true as const, data: {}, riskLevel: 'high' as const }));
    const { service, approvalId } = await proposeAndApprove(repo, fakeRunner(run), { approvalExpiryDays: 1 });

    const wellAfterExpiry = new Date(NOW.getTime() + 2 * 24 * 60 * 60 * 1000);
    const result = await service.decide('acme', approvalId, 'approve', 'key_1', wellAfterExpiry, tenantSettings(), alwaysFreshOrder);

    expect(result.ok).toBe(false);
    expect(!result.ok && result.code).toBe('EXPIRED');
    expect(run).not.toHaveBeenCalled();
  });

  it('a nonexistent approval id returns NOT_FOUND', async () => {
    const repo = new InMemoryApprovalRepository();
    const service = new ApprovalService(repo, fakeRunner());
    const result = await service.decide('acme', 'ffffffffffffffffffffffff', 'approve', 'key_1', NOW, tenantSettings(), alwaysFreshOrder);
    expect(result).toEqual({ ok: false, code: 'NOT_FOUND' });
  });

  it('approve on an already-executed approval returns ALREADY_DECIDED', async () => {
    const repo = new InMemoryApprovalRepository();
    const { service, approvalId } = await proposeAndApprove(repo, fakeRunner());
    await service.decide('acme', approvalId, 'approve', 'key_1', NOW, tenantSettings(), alwaysFreshOrder);

    const second = await service.decide('acme', approvalId, 'approve', 'key_2', NOW, tenantSettings(), alwaysFreshOrder);
    expect(second).toEqual({ ok: false, code: 'ALREADY_DECIDED' });
  });

  it('approve on an executing row still within the lease returns IN_PROGRESS, no new upstream call', async () => {
    const repo = new InMemoryApprovalRepository();
    const hangs = () => new Promise<ToolRunResult>(() => {});
    const run = vi.fn(hangs);
    const { service, approvalId } = await proposeAndApprove(repo, fakeRunner(run));

    // Fire the first approve without awaiting (it hangs inside the runner, leaving status 'executing').
    void service.decide('acme', approvalId, 'approve', 'key_1', NOW, tenantSettings(), alwaysFreshOrder);
    await new Promise((r) => setTimeout(r, 10));

    const second = await service.decide('acme', approvalId, 'approve', 'key_2', NOW, tenantSettings(), alwaysFreshOrder);
    expect(second).toEqual({ ok: false, code: 'IN_PROGRESS' });
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('lease takeover: approve on an executing row PAST the lease succeeds via the atomic steal', async () => {
    const repo = new InMemoryApprovalRepository();
    const hangs = () => new Promise<ToolRunResult>(() => {});
    const { service, approvalId } = await proposeAndApprove(repo, fakeRunner(hangs));

    void service.decide('acme', approvalId, 'approve', 'key_1', NOW, tenantSettings(), alwaysFreshOrder);
    await new Promise((r) => setTimeout(r, 5));

    const run2 = vi.fn(async () => ({ ok: true as const, data: {}, riskLevel: 'high' as const }));
    const service2 = new ApprovalService(repo, fakeRunner(run2), { executionLeaseMs: 1 });
    await new Promise((r) => setTimeout(r, 10)); // past the 1ms lease
    const later = new Date(NOW.getTime() + 120_000);
    const result = await service2.decide('acme', approvalId, 'approve', 'key_2', later, tenantSettings(), alwaysFreshOrder);

    expect(result.ok).toBe(true);
    expect(result.ok && result.status).toBe('executed');
    const stored = await repo.findById('acme', approvalId);
    expect(stored?.attemptCount).toBe(2);
  });

  it('retry after an AMBIGUOUS failure, where the upstream call actually succeeded (idempotent replay): the retry reports executed, exactly one real refund happened', async () => {
    const repo = new InMemoryApprovalRepository();
    let callCount = 0;
    const run = vi.fn(async (_approval: { idempotencyKey: string }): Promise<ToolRunResult> => {
      callCount += 1;
      if (callCount === 1) {
        // We never heard back in time - but the store DID receive and apply it.
        return { ok: false, error: { code: 'TIMEOUT', message: 'Upstream request timed out.' } };
      }
      // The retry's identical idempotencyKey makes this an idempotent replay - the store
      // returns the SAME success it already recorded, never a second refund.
      return { ok: true, data: { status: 'refunded' }, riskLevel: 'high' };
    });
    const { service, approvalId } = await proposeAndApprove(repo, fakeRunner(run));

    const first = await service.decide('acme', approvalId, 'approve', 'key_1', NOW, tenantSettings(), alwaysFreshOrder);
    expect(first.ok && first.status).toBe('failed');
    const afterFirst = await repo.findById('acme', approvalId);
    expect(afterFirst?.retryable).toBe(true);

    const retry = await service.decide('acme', approvalId, 'approve', 'key_1', NOW, tenantSettings(), alwaysFreshOrder);
    expect(retry.ok).toBe(true);
    expect(retry.ok && retry.status).toBe('executed');
    expect(run).toHaveBeenCalledTimes(2); // two of OUR attempts, but...
    expect(run.mock.calls[0][0].idempotencyKey).toBe(run.mock.calls[1][0].idempotencyKey); // ...the SAME idempotency key both times
  });

  it('reject is BLOCKED after an AMBIGUOUS failure (amendment A)', async () => {
    const repo = new InMemoryApprovalRepository();
    const failure: ToolRunResult = { ok: false, error: { code: 'TIMEOUT', message: 'Upstream request timed out.' } };
    const { service, approvalId } = await proposeAndApprove(repo, fakeRunner(async () => failure));

    await service.decide('acme', approvalId, 'approve', 'key_1', NOW, tenantSettings(), alwaysFreshOrder);
    const rejectResult = await service.decide('acme', approvalId, 'reject', 'key_1', NOW, tenantSettings(), alwaysFreshOrder);

    expect(rejectResult).toEqual({ ok: false, code: 'AMBIGUOUS_RETRY_REQUIRED' });
  });

  it('reject IS allowed after a NOT_SENT failure (amendment F4)', async () => {
    const repo = new InMemoryApprovalRepository();
    const failure: ToolRunResult = { ok: false, error: { code: 'SECRET_NOT_CONFIGURED', message: 'Connector secret is not configured.' } };
    const { service, approvalId } = await proposeAndApprove(repo, fakeRunner(async () => failure));

    await service.decide('acme', approvalId, 'approve', 'key_1', NOW, tenantSettings(), alwaysFreshOrder);
    const rejectResult = await service.decide('acme', approvalId, 'reject', 'key_1', NOW, tenantSettings(), alwaysFreshOrder);

    expect(rejectResult.ok).toBe(true);
    expect(rejectResult.ok && rejectResult.status).toBe('rejected');
  });
});

describe('ApprovalService.getById / list - lazy expiry (amendment F2)', () => {
  it('getById on a stale pending row actually writes the expiry, not just displays it', async () => {
    const repo = new InMemoryApprovalRepository();
    const service = new ApprovalService(repo, fakeRunner());
    const proposed = await service.createFromProposal(proposalInput({ approvalExpiryDays: 1 }));
    const approvalId = (proposed as { approvalId: string }).approvalId;

    const wellAfterExpiry = new Date(NOW.getTime() + 2 * 24 * 60 * 60 * 1000);
    const viaService = await service.getById('acme', approvalId, wellAfterExpiry);
    expect(viaService?.status).toBe('expired');

    const viaRepoDirectly = await repo.findById('acme', approvalId);
    expect(viaRepoDirectly?.status).toBe('expired'); // the write actually happened, not just a display-time computation
  });

  it('list() also lazily expires stale pending rows it returns', async () => {
    const repo = new InMemoryApprovalRepository();
    const service = new ApprovalService(repo, fakeRunner());
    await service.createFromProposal(proposalInput({ orderId: 'ORD-1001', approvalExpiryDays: 1 }));

    const wellAfterExpiry = new Date(NOW.getTime() + 2 * 24 * 60 * 60 * 1000);
    const { approvals } = await service.list('acme', {}, wellAfterExpiry);
    expect(approvals[0].status).toBe('expired');
  });
});
