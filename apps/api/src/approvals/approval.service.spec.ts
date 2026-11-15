import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { InMemoryApprovalRepository } from '../db/test-utils/in-memory-approval.repository';
import { ApprovalService, CreateFromProposalInput, FetchFreshOrderSnapshot } from './approval.service';
import { PersistAgentRunForProposal } from './approval-proposal.port';
import { PrivilegedRefundRunner } from './privileged-refund-runner';
import { RefundVerifierOrderSnapshot, RefundVerifierTenantSettings } from './refund-verifier';
import { ToolRunResult } from '../agent/tool-runner/tool-runner';
import { TransactionRunner } from '../db/transaction-runner';
import { ApprovalRepository } from './approval.repository';

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

// A fresh runId per call by default - most tests here are about independent proposals (two
// different chat turns), not the {tenantId, runId} idempotency behavior itself (Stage 5
// follow-up I1(b)); reusing one fixed literal would make every "second proposal" collide with
// the newer runId-uniqueness constraint before ever reaching the one it's actually testing
// (e.g. the active-per-order one). Tests that DO care about the idempotent-retry behavior pass
// an explicit, SHARED runId across both calls.
function proposalInput(overrides: Partial<CreateFromProposalInput> = {}): CreateFromProposalInput {
  return {
    tenantId: 'acme',
    runId: `run_${randomUUID()}`,
    conversationId: 'conv_1',
    orderId: 'ORD-1001',
    verifiedCustomerRef: 'cust_1',
    amountCents: 5000,
    citations: ['d1-0'],
    orderSnapshot: orderSnapshot(),
    tenantSettings: tenantSettings(),
    approvalExpiryDays: 7,
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

const alwaysFreshOrder: FetchFreshOrderSnapshot = async (_tenantId, _orderId) => ({ ok: true, snapshot: orderSnapshot() });

/**
 * Stage 5's transactional dual-write hook - these tests only care about ApprovalService's own
 * outcomes/state, never about the AgentRun side of the write (that's chat.service.spec.ts's and
 * the Stage 5 integration spec's territory), so a no-op stands in everywhere. No transaction
 * runner is wired in this file either (every `new ApprovalService(...)` below omits it), so
 * createApprovalRow's own standalone fallback path - a plain sequential create() then
 * persistAgentRun() with no shared session - is what every test here actually exercises.
 */
const noopPersistAgentRun: PersistAgentRunForProposal = async () => {};

describe('ApprovalService.createFromProposal', () => {
  it('denied: a failed rule never creates an Approval row', async () => {
    const repo = new InMemoryApprovalRepository();
    const service = new ApprovalService(repo, fakeRunner());
    const result = await service.createFromProposal(proposalInput({ citations: [] }), noopPersistAgentRun);

    expect(result.kind).toBe('denied');
    expect(result.kind === 'denied' && result.failedRuleCodes).toEqual(['MISSING_POLICY_CITATION']);
    expect((await repo.list('acme', {})).approvals).toHaveLength(0);
  });

  it('already_pending: a second proposal for an order with an active approval creates no new row', async () => {
    const repo = new InMemoryApprovalRepository();
    const service = new ApprovalService(repo, fakeRunner());
    const first = await service.createFromProposal(proposalInput(), noopPersistAgentRun);
    expect(first.kind).toBe('pending_approval');

    const second = await service.createFromProposal(proposalInput(), noopPersistAgentRun);
    expect(second.kind).toBe('already_pending');
    expect(second.kind === 'already_pending' && second.approvalId).toBe(first.kind === 'pending_approval' ? first.approvalId : undefined);
    expect((await repo.list('acme', {})).approvals).toHaveLength(1);
  });

  it('pending_approval: every rule passes, autoExecuteRefunds is off', async () => {
    const repo = new InMemoryApprovalRepository();
    const service = new ApprovalService(repo, fakeRunner());
    const result = await service.createFromProposal(proposalInput(), noopPersistAgentRun);

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
      noopPersistAgentRun,
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
      noopPersistAgentRun,
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
      noopPersistAgentRun,
    );

    expect(result.kind).toBe('auto_executed');
    expect(result.kind === 'auto_executed' && result.success).toBe(false);
  }, 2_000);

  it('amendment F2: a stale PENDING row past its own expiry is expired and the insert retried automatically', async () => {
    const repo = new InMemoryApprovalRepository();
    const service = new ApprovalService(repo, fakeRunner());

    const first = await service.createFromProposal(proposalInput({ approvalExpiryDays: 1, now: NOW }), noopPersistAgentRun);
    expect(first.kind).toBe('pending_approval');

    const wellAfterExpiry = new Date(NOW.getTime() + 2 * 24 * 60 * 60 * 1000);
    const second = await service.createFromProposal(proposalInput({ approvalExpiryDays: 7, now: wellAfterExpiry }), noopPersistAgentRun);

    expect(second.kind).toBe('pending_approval');
    expect((second as { approvalId: string }).approvalId).not.toBe((first as { approvalId: string }).approvalId);
    const firstRecord = await repo.findById('acme', (first as { approvalId: string }).approvalId);
    expect(firstRecord?.status).toBe('expired');
  });

  it('amendment F2: a genuinely still-active blocking row (not expired) is reported as already_pending, no retry', async () => {
    const repo = new InMemoryApprovalRepository();
    const service = new ApprovalService(repo, fakeRunner());
    const first = await service.createFromProposal(proposalInput({ approvalExpiryDays: 30 }), noopPersistAgentRun);

    const secondAttempt = await service.createFromProposal(
      proposalInput({ approvalExpiryDays: 30, now: new Date(NOW.getTime() + 1000) }),
      noopPersistAgentRun,
    );
    expect(secondAttempt.kind).toBe('already_pending');
    expect((secondAttempt as { approvalId: string }).approvalId).toBe((first as { approvalId: string }).approvalId);
  });
});

describe('ApprovalService.createFromProposal - transactional dual-write (Stage 5 amendment D/C)', () => {
  /**
   * A fake TransactionRunner - just calls the callback with a marker object standing in for a
   * real Mongoose ClientSession, so tests can assert both writes received the exact SAME one.
   * Cast through `unknown`, same as `fakeRunner`'s own cast above: TransactionRunner's real
   * signature is generic over a real `ClientSession`, which this fake deliberately never
   * constructs (no real Mongo connection in a unit test).
   */
  function fakeTransactionRunner(sessionMarker: unknown): TransactionRunner {
    return { withTransaction: async (fn: (session: unknown) => Promise<unknown>) => fn(sessionMarker) } as unknown as TransactionRunner;
  }

  it('require_approval: repository.create and persistAgentRun both receive the SAME session from one shared transaction', async () => {
    const repo: ApprovalRepository = new InMemoryApprovalRepository();
    const createSpy = vi.spyOn(repo, 'create');
    const sessionMarker = { fakeSession: true };
    const service = new ApprovalService(repo, fakeRunner(), undefined, fakeTransactionRunner(sessionMarker));

    const persistCalls: Array<{ session: unknown }> = [];
    const recordingPersist: PersistAgentRunForProposal = async (_disposition, session) => {
      persistCalls.push({ session });
    };

    const result = await service.createFromProposal(proposalInput(), recordingPersist);

    expect(result.kind).toBe('pending_approval');
    expect(createSpy).toHaveBeenCalledTimes(1);
    expect(createSpy.mock.calls[0][1]).toBe(sessionMarker);
    expect(persistCalls).toHaveLength(1);
    expect(persistCalls[0].session).toBe(sessionMarker);
  });

  it('auto_execute: the row-creation transaction uses the shared session too, before execution (which happens outside any transaction)', async () => {
    const repo: ApprovalRepository = new InMemoryApprovalRepository();
    const createSpy = vi.spyOn(repo, 'create');
    const sessionMarker = { fakeSession: true };
    const run = vi.fn(async () => ({ ok: true as const, data: { status: 'refunded' }, riskLevel: 'high' as const }));
    const service = new ApprovalService(repo, fakeRunner(run), undefined, fakeTransactionRunner(sessionMarker));

    const persistCalls: Array<{ disposition: { kind: string }; session: unknown }> = [];
    const recordingPersist: PersistAgentRunForProposal = async (disposition, session) => {
      persistCalls.push({ disposition, session });
    };

    const result = await service.createFromProposal(
      proposalInput({ tenantSettings: tenantSettings({ autoExecuteRefunds: true, approvalThreshold: 250 }) }),
      recordingPersist,
    );

    expect(result.kind).toBe('auto_executed');
    expect(createSpy.mock.calls[0][1]).toBe(sessionMarker);
    expect(persistCalls).toHaveLength(1);
    expect(persistCalls[0].disposition.kind).toBe('auto_executed');
    expect(persistCalls[0].session).toBe(sessionMarker);
    expect(run).toHaveBeenCalledTimes(1); // the privileged call happened AFTER the transaction committed, never inside it
  });

  it('a transaction failure (neither write committed) propagates to the caller rather than being swallowed', async () => {
    const repo = new InMemoryApprovalRepository();
    const failingTransactionRunner = {
      withTransaction: async () => Promise.reject(new Error('simulated transaction failure')),
    } as unknown as TransactionRunner;
    const service = new ApprovalService(repo, fakeRunner(), undefined, failingTransactionRunner);

    await expect(service.createFromProposal(proposalInput(), noopPersistAgentRun)).rejects.toThrow('simulated transaction failure');
    expect((await repo.list('acme', {})).approvals).toHaveLength(0); // no partial row left behind
  });

  it('denied and already_pending dispositions use a plain standalone write - no transactionRunner call at all', async () => {
    const repo = new InMemoryApprovalRepository();
    const transactionRunner = {
      withTransaction: vi.fn(async (fn: (session: unknown) => Promise<unknown>) => fn(undefined)),
    } as unknown as TransactionRunner;
    const service = new ApprovalService(repo, fakeRunner(), undefined, transactionRunner);

    const deniedCalls: string[] = [];
    const recordingPersist: PersistAgentRunForProposal = async (disposition) => {
      deniedCalls.push(disposition.kind);
    };

    const denied = await service.createFromProposal(proposalInput({ citations: [] }), recordingPersist);
    expect(denied.kind).toBe('denied');
    expect(transactionRunner.withTransaction).not.toHaveBeenCalled();
    expect(deniedCalls).toEqual(['denied']);

    await service.createFromProposal(proposalInput(), recordingPersist); // creates the real pending row (uses the transaction)
    const alreadyPending = await service.createFromProposal(proposalInput(), recordingPersist);
    expect(alreadyPending.kind).toBe('already_pending');
    expect(deniedCalls).toEqual(['denied', 'pending_approval', 'already_pending']);
  });
});

describe('ApprovalService.decide - approve', () => {
  async function proposeAndApprove(repo: InMemoryApprovalRepository, runner: PrivilegedRefundRunner, overrides: Partial<CreateFromProposalInput> = {}) {
    const service = new ApprovalService(repo, runner);
    const proposed = await service.createFromProposal(proposalInput(overrides), noopPersistAgentRun);
    const approvalId = (proposed as { approvalId: string }).approvalId;
    return { service, approvalId };
  }

  it('a verifier failure on the FIRST attempt denies without ever calling the runner', async () => {
    const repo = new InMemoryApprovalRepository();
    const run = vi.fn(async () => ({ ok: true as const, data: {}, riskLevel: 'high' as const }));
    const { service, approvalId } = await proposeAndApprove(repo, fakeRunner(run));

    // The order is now cancelled by the time an admin looks at it.
    const fetchChangedOrder: FetchFreshOrderSnapshot = async () => ({ ok: true, snapshot: orderSnapshot({ status: 'cancelled' }) });
    const result = await service.decide('acme', approvalId, 'approve', 'key_1', NOW, tenantSettings(), fetchChangedOrder);

    expect(result.ok).toBe(false);
    expect(!result.ok && result.code).toBe('VERIFIER_DENIED');
    expect(run).not.toHaveBeenCalled();
    const stored = await repo.findById('acme', approvalId);
    expect(stored?.status).toBe('failed');
    expect(stored?.retryable).toBe(false);
  });

  // Stage 6 - the fetch itself failing must NEVER be treated as the order being ineligible.
  it('a FETCH_FAILED order lookup leaves the approval exactly as it was - still pending, no state change, ORDER_FETCH_FAILED', async () => {
    const repo = new InMemoryApprovalRepository();
    const run = vi.fn(async () => ({ ok: true as const, data: {}, riskLevel: 'high' as const }));
    const { service, approvalId } = await proposeAndApprove(repo, fakeRunner(run));

    const fetchFails: FetchFreshOrderSnapshot = async () => ({ ok: false, reason: 'FETCH_FAILED' });
    const result = await service.decide('acme', approvalId, 'approve', 'key_1', NOW, tenantSettings(), fetchFails);

    expect(result).toEqual({ ok: false, code: 'ORDER_FETCH_FAILED' });
    expect(run).not.toHaveBeenCalled();
    const stored = await repo.findById('acme', approvalId);
    expect(stored?.status).toBe('pending'); // untouched - no state change at all
    expect(stored?.attemptCount).toBe(0);

    // A later retry with a HEALTHY fetch succeeds normally - nothing about the failed attempt
    // above left this approval in a worse state than before.
    const retry = await service.decide('acme', approvalId, 'approve', 'key_1', NOW, tenantSettings(), alwaysFreshOrder);
    expect(retry.ok).toBe(true);
    expect(retry.ok && retry.status).toBe('executed');
  });

  it('a NOT_FOUND order lookup (genuinely deleted/ineligible) denies with a real state change, distinct from FETCH_FAILED', async () => {
    const repo = new InMemoryApprovalRepository();
    const run = vi.fn(async () => ({ ok: true as const, data: {}, riskLevel: 'high' as const }));
    const { service, approvalId } = await proposeAndApprove(repo, fakeRunner(run));

    const fetchNotFound: FetchFreshOrderSnapshot = async () => ({ ok: false, reason: 'NOT_FOUND' });
    const result = await service.decide('acme', approvalId, 'approve', 'key_1', NOW, tenantSettings(), fetchNotFound);

    expect(result.ok).toBe(false);
    expect(!result.ok && result.code).toBe('VERIFIER_DENIED');
    expect(run).not.toHaveBeenCalled();
    const stored = await repo.findById('acme', approvalId);
    expect(stored?.status).toBe('failed');
    expect(stored?.retryable).toBe(false);
    expect(stored?.reasonCode).toBe('ORDER_STATUS_INELIGIBLE');
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
    const proposed = await service.createFromProposal(proposalInput({ approvalExpiryDays: 1 }), noopPersistAgentRun);
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
    await service.createFromProposal(proposalInput({ orderId: 'ORD-1001', approvalExpiryDays: 1 }), noopPersistAgentRun);

    const wellAfterExpiry = new Date(NOW.getTime() + 2 * 24 * 60 * 60 * 1000);
    const { approvals } = await service.list('acme', {}, wellAfterExpiry);
    expect(approvals[0].status).toBe('expired');
  });
});

describe('Stage 5 follow-up I1: retrying past the persistence phase is unsafe, and is now structurally impossible', () => {
  /** Intercepts exactly ONE method call on a real ApprovalRepository, delegating everything else - avoids hand-writing a dozen passthrough methods for each narrow fault-injection test below. */
  function interceptOnce<K extends keyof ApprovalRepository>(
    real: ApprovalRepository,
    method: K,
    onFirstCall: () => never,
  ): ApprovalRepository {
    let intercepted = false;
    return new Proxy(real, {
      get(target, prop, receiver) {
        if (prop === method && !intercepted) {
          intercepted = true;
          return onFirstCall;
        }
        return Reflect.get(target, prop, receiver);
      },
    });
  }

  it('an exception during execution (e.g. a markExecuted write failure AFTER the real refund already succeeded) never claims success and is NEVER retried via a fresh createFromProposal call', async () => {
    const realRepo = new InMemoryApprovalRepository();
    const repo = interceptOnce(realRepo, 'markExecuted', () => {
      throw new Error('simulated markExecuted persistence failure (the refund itself already succeeded)');
    });
    const run = vi.fn(async () => ({ ok: true as const, data: { status: 'refunded' }, riskLevel: 'high' as const }));
    const service = new ApprovalService(repo, fakeRunner(run));

    const result = await service.createFromProposal(
      proposalInput({ amountCents: 5000, tenantSettings: tenantSettings({ autoExecuteRefunds: true, approvalThreshold: 250 }) }),
      noopPersistAgentRun,
    );

    // Never claims success - the exception is caught and reported as a plain failure, never
    // re-thrown out of createFromProposal (amendment I1(a)).
    expect(result.kind).toBe('auto_executed');
    expect(result.kind === 'auto_executed' && result.success).toBe(false);
    // The privileged runner (the thing that actually moves money) was called EXACTLY once -
    // the failure happened AFTER that call, recording it is what failed, and nothing in
    // createFromProposal re-attempts the call itself in response.
    expect(run).toHaveBeenCalledTimes(1);
    // Exactly one Approval row exists - no second row was created by this failure.
    expect((await realRepo.list('acme', {})).approvals).toHaveLength(1);
  });

  it('a partial-amount refund: a second createFromProposal call for the SAME run, after the first already fully executed, issues NO second refund and creates NO second Approval - even though the stale orderSnapshot would otherwise still pass the verifier', async () => {
    // The order has $100.00 remaining refundable per the (never re-fetched) orderSnapshot this
    // run captured at the START of the request - a $40.00 partial refund leaves $60.00 looking
    // "still refundable" by that same stale snapshot, forever, no matter how many times a
    // caller re-proposes using it. This is exactly the dangerous case amendment I1 closes: the
    // snapshot never updates, so the ONLY thing standing between this and a double refund is
    // the approval's own state machine, not re-verification.
    const repo = new InMemoryApprovalRepository();
    const run = vi.fn(async () => ({ ok: true as const, data: { status: 'refunded' }, riskLevel: 'high' as const }));
    const service = new ApprovalService(repo, fakeRunner(run));

    const sharedInput = proposalInput({
      runId: 'run_partial_retry',
      amountCents: 4000, // $40.00 of a $100.00 order (orderSnapshot's default totalCents is 10000, alreadyRefundedCents 0)
      tenantSettings: tenantSettings({ autoExecuteRefunds: true, approvalThreshold: 250 }),
    });

    const first = await service.createFromProposal(sharedInput, noopPersistAgentRun);
    expect(first.kind).toBe('auto_executed');
    expect(first.kind === 'auto_executed' && first.success).toBe(true);
    expect(run).toHaveBeenCalledTimes(1);

    // Simulate the exact scenario the old design made dangerous: something calls
    // createFromProposal AGAIN for the same run (the SAME stale snapshot, which still claims
    // $100.00 remaining) - e.g. an outer caller mistakenly retrying the whole proposal, not
    // just its persistence phase.
    const second = await service.createFromProposal(sharedInput, noopPersistAgentRun);

    // No second refund - the runner was never called again.
    expect(run).toHaveBeenCalledTimes(1);
    // No second Approval row - the SAME run still maps to exactly one.
    expect((await repo.list('acme', {})).approvals).toHaveLength(1);
    // The second call's own persistence phase read back the SAME (already-executed) approval
    // rather than creating a new one, and runAutoExecute's beginExecution correctly refused to
    // re-begin execution on a row that is no longer 'pending' - never claims success either.
    expect(second.kind).toBe('auto_executed');
    expect(second.kind === 'auto_executed' && second.success).toBe(false);
    const stored = (await repo.list('acme', {})).approvals[0];
    expect(stored.status).toBe('executed');
    expect(stored.amountCents).toBe(4000); // the ORIGINAL amount - never overwritten or duplicated
  });

  it('createApprovalRowWithRetry (the ONLY retried step) never touches beginExecution/the privileged runner - it wraps exactly the persistence transaction', async () => {
    const repo = new InMemoryApprovalRepository();
    const beginExecutionSpy = vi.spyOn(repo, 'beginExecution');
    const run = vi.fn(async () => ({ ok: true as const, data: { status: 'refunded' }, riskLevel: 'high' as const }));

    // Force the FIRST persistence attempt to fail with a genuine (non-duplicate-key) infra
    // error, so createApprovalRowWithRetry's own one retry actually fires.
    let createCalls = 0;
    const realCreate = repo.create.bind(repo);
    repo.create = async (input) => {
      createCalls += 1;
      if (createCalls === 1) {
        throw new Error('simulated transient infra failure on the first persistence attempt');
      }
      return realCreate(input);
    };

    const service = new ApprovalService(repo, fakeRunner(run), undefined, undefined); // no TransactionRunner - standalone fallback path

    const result = await service.createFromProposal(
      proposalInput({ tenantSettings: tenantSettings({ autoExecuteRefunds: true, approvalThreshold: 250 }) }),
      noopPersistAgentRun,
    );

    expect(createCalls).toBe(2); // the persistence phase really did retry once
    expect(result.kind).toBe('auto_executed');
    // beginExecution (the first step PAST the persistence phase) was called exactly once -
    // the retry above happened entirely BEFORE this, never re-triggering execution.
    expect(beginExecutionSpy).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('a genuine infra failure during the standalone (denied) AgentRun write is retried once, idempotently, via DuplicateAgentRunError - never by re-running the verifier', async () => {
    const calls: unknown[] = [];
    let attempt = 0;
    const flakyPersistAgentRun: PersistAgentRunForProposal = async (disposition) => {
      attempt += 1;
      calls.push(disposition);
      if (attempt === 1) {
        throw new Error('simulated transient infra failure');
      }
      // second attempt succeeds - nothing more to assert here since this fake doesn't model
      // DuplicateAgentRunError itself; approval.service.ts's own standalone-write test above
      // already covers the "already recorded" branch via the real repository.
    };
    const repo = new InMemoryApprovalRepository();
    const service = new ApprovalService(repo, fakeRunner());

    const result = await service.createFromProposal(proposalInput({ citations: [] }), flakyPersistAgentRun);

    expect(result.kind).toBe('denied');
    expect(calls).toHaveLength(2); // retried exactly once
    expect(calls[0]).toEqual(calls[1]); // the SAME disposition both times - never re-verified
  });
});
