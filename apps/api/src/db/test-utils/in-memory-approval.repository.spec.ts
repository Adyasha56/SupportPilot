import { describe, expect, it } from 'vitest';
import { NewApproval } from '../../approvals/approval.repository';
import { InMemoryApprovalRepository } from './in-memory-approval.repository';

const NOW = new Date('2026-11-09T00:00:00.000Z');

function newApproval(overrides: Partial<NewApproval> = {}): NewApproval {
  return {
    tenantId: 'acme',
    runId: 'run_1',
    conversationId: 'conv_1',
    orderId: 'ORD-1001',
    customerRef: 'cust_1',
    amountCents: 5000,
    citations: ['d1-0'],
    verifierVerdictAtProposal: [{ code: 'ORDER_OWNERSHIP_MISMATCH', passed: true }],
    now: NOW,
    approvalExpiryDays: 7,
    ...overrides,
  };
}

async function createPending(repo: InMemoryApprovalRepository, overrides: Partial<NewApproval> = {}) {
  return repo.create(newApproval(overrides));
}

describe('InMemoryApprovalRepository.create', () => {
  it('creates a pending, active row with a derived idempotency key and no follow-up write needed', async () => {
    const repo = new InMemoryApprovalRepository();
    const record = await createPending(repo);
    expect(record.status).toBe('pending');
    expect(record.active).toBe(true);
    expect(record.idempotencyKey).toBe(`apr_${record.id}`);
    expect(record.attemptCount).toBe(0);
    expect(record.executingSince).toBeNull();
    expect(record.expiresAt.getTime()).toBe(NOW.getTime() + 7 * 24 * 60 * 60 * 1000);
  });

  it('two proposals for the same order both succeed at the repository level - the active-uniqueness guarantee is the caller/index\'s job, not create()\'s', async () => {
    // (confirmed deliberately: create() itself has no notion of "already active for this order" -
    // that's the partial unique index's job in the real repository, exercised by the integration
    // tests; this in-memory fake doesn't attempt to reproduce a database-level unique constraint.)
    const repo = new InMemoryApprovalRepository();
    const first = await createPending(repo, { orderId: 'ORD-1001' });
    const second = await createPending(repo, { orderId: 'ORD-1001' });
    expect(first.id).not.toBe(second.id);
  });
});

describe('InMemoryApprovalRepository - tenant isolation', () => {
  it('findById never matches a real id under the wrong tenant', async () => {
    const repo = new InMemoryApprovalRepository();
    const record = await createPending(repo, { tenantId: 'acme' });
    expect(await repo.findById('globex', record.id)).toBeNull();
    expect(await repo.findById('acme', record.id)).not.toBeNull();
  });

  it('no transition method matches a real id under the wrong tenant', async () => {
    const repo = new InMemoryApprovalRepository();
    const record = await createPending(repo, { tenantId: 'acme' });
    expect(await repo.beginExecution('globex', record.id, [], NOW)).toBeNull();
    expect(await repo.reject('globex', record.id, 'key_1', NOW)).toBeNull();
    expect(await repo.expire('globex', record.id, NOW)).toBeNull();
  });
});

describe('InMemoryApprovalRepository.beginExecution', () => {
  it('pending -> executing, setting executionStartedAt/executingSince/attemptCount on the first attempt', async () => {
    const repo = new InMemoryApprovalRepository();
    const created = await createPending(repo);
    const result = await repo.beginExecution('acme', created.id, [{ code: 'ORDER_OWNERSHIP_MISMATCH', passed: true }], NOW);
    expect(result?.status).toBe('executing');
    expect(result?.executionStartedAt).toEqual(NOW);
    expect(result?.executingSince).toEqual(NOW);
    expect(result?.attemptCount).toBe(1);
    expect(result?.verifierVerdictAtDecision).toEqual([{ code: 'ORDER_OWNERSHIP_MISMATCH', passed: true }]);
  });

  it('lost race: a second beginExecution on the same (already-executing) row returns null, never a second transition', async () => {
    const repo = new InMemoryApprovalRepository();
    const created = await createPending(repo);
    const first = await repo.beginExecution('acme', created.id, [], NOW);
    const second = await repo.beginExecution('acme', created.id, [], NOW);
    expect(first).not.toBeNull();
    expect(second).toBeNull();
  });

  it('never transitions a nonexistent id', async () => {
    const repo = new InMemoryApprovalRepository();
    expect(await repo.beginExecution('acme', 'ffffffffffffffffffffffff', [], NOW)).toBeNull();
  });
});

describe('InMemoryApprovalRepository.takeOverStuckExecution (amendment B lease steal)', () => {
  it('succeeds only when executingSince matches the exact stale value just read', async () => {
    const repo = new InMemoryApprovalRepository();
    const created = await createPending(repo);
    const begun = await repo.beginExecution('acme', created.id, [], NOW);
    const staleExecutingSince = begun!.executingSince!;
    const later = new Date(NOW.getTime() + 120_000);

    const result = await repo.takeOverStuckExecution('acme', created.id, staleExecutingSince, later);
    expect(result?.executingSince).toEqual(later);
    expect(result?.attemptCount).toBe(2);
  });

  it('lost race: two concurrent steal attempts against the same stale value - only the first wins', async () => {
    const repo = new InMemoryApprovalRepository();
    const created = await createPending(repo);
    const begun = await repo.beginExecution('acme', created.id, [], NOW);
    const staleExecutingSince = begun!.executingSince!;
    const later = new Date(NOW.getTime() + 120_000);

    const first = await repo.takeOverStuckExecution('acme', created.id, staleExecutingSince, later);
    const second = await repo.takeOverStuckExecution('acme', created.id, staleExecutingSince, later);
    expect(first).not.toBeNull();
    expect(second).toBeNull(); // the second call's stale value no longer matches - the first steal already refreshed it
  });

  it('never matches a row that is not currently executing', async () => {
    const repo = new InMemoryApprovalRepository();
    const created = await createPending(repo);
    expect(await repo.takeOverStuckExecution('acme', created.id, NOW, NOW)).toBeNull();
  });
});

describe('InMemoryApprovalRepository.retryFromFailed (amendment A - no re-verification)', () => {
  async function setupRetryableFailure(repo: InMemoryApprovalRepository) {
    const created = await createPending(repo);
    await repo.beginExecution('acme', created.id, [], NOW);
    await repo.markFailed('acme', created.id, { retryable: true, executionResultCode: 'UPSTREAM_TIMEOUT' }, NOW);
    return created.id;
  }

  it('failed (retryable) -> executing, incrementing attemptCount, without touching executionStartedAt', async () => {
    const repo = new InMemoryApprovalRepository();
    const id = await setupRetryableFailure(repo);
    const later = new Date(NOW.getTime() + 60_000);

    const result = await repo.retryFromFailed('acme', id, later);
    expect(result?.status).toBe('executing');
    expect(result?.attemptCount).toBe(2);
    expect(result?.executionStartedAt).toEqual(NOW); // unchanged from the first attempt
    expect(result?.executingSince).toEqual(later);
  });

  it('never retries a non-retryable failure', async () => {
    const repo = new InMemoryApprovalRepository();
    const created = await createPending(repo);
    await repo.beginExecution('acme', created.id, [], NOW);
    await repo.markFailed('acme', created.id, { retryable: false, executionResultCode: 'ALREADY_REFUNDED_UPSTREAM' }, NOW);

    expect(await repo.retryFromFailed('acme', created.id, NOW)).toBeNull();
  });

  it('lost race: two retry attempts on the same failed row - only the first wins', async () => {
    const repo = new InMemoryApprovalRepository();
    const id = await setupRetryableFailure(repo);
    const first = await repo.retryFromFailed('acme', id, NOW);
    const second = await repo.retryFromFailed('acme', id, NOW);
    expect(first).not.toBeNull();
    expect(second).toBeNull();
  });
});

describe('InMemoryApprovalRepository.markExecuted', () => {
  it('executing -> executed, active: false, executionResultCode recorded', async () => {
    const repo = new InMemoryApprovalRepository();
    const created = await createPending(repo);
    await repo.beginExecution('acme', created.id, [], NOW);

    const result = await repo.markExecuted('acme', created.id, 'OK', NOW);
    expect(result?.status).toBe('executed');
    expect(result?.active).toBe(false);
    expect(result?.executionResultCode).toBe('OK');
  });

  it('never executes a row that is not currently executing (e.g. still pending)', async () => {
    const repo = new InMemoryApprovalRepository();
    const created = await createPending(repo);
    expect(await repo.markExecuted('acme', created.id, 'OK', NOW)).toBeNull();
  });

  it('lost race: a row already marked executed can never be marked executed again', async () => {
    const repo = new InMemoryApprovalRepository();
    const created = await createPending(repo);
    await repo.beginExecution('acme', created.id, [], NOW);
    const first = await repo.markExecuted('acme', created.id, 'OK', NOW);
    const second = await repo.markExecuted('acme', created.id, 'OK', NOW);
    expect(first).not.toBeNull();
    expect(second).toBeNull();
  });
});

describe('InMemoryApprovalRepository.markFailed', () => {
  it('pending -> failed, non-retryable, when the decision-time verifier re-check itself fails (no upstream attempt made)', async () => {
    const repo = new InMemoryApprovalRepository();
    const created = await createPending(repo);
    const result = await repo.markFailed(
      'acme',
      created.id,
      { retryable: false, reasonCode: 'ORDER_STATUS_INELIGIBLE', verifierVerdictAtDecision: [{ code: 'ORDER_STATUS_INELIGIBLE', passed: false }] },
      NOW,
    );
    expect(result?.status).toBe('failed');
    expect(result?.retryable).toBe(false);
    expect(result?.active).toBe(false); // non-retryable denial is terminal
    expect(result?.reasonCode).toBe('ORDER_STATUS_INELIGIBLE');
    expect(result?.attemptCount).toBe(0); // no execution was ever attempted
  });

  it('executing -> failed, retryable (ambiguous upstream outcome) stays active', async () => {
    const repo = new InMemoryApprovalRepository();
    const created = await createPending(repo);
    await repo.beginExecution('acme', created.id, [], NOW);
    const result = await repo.markFailed('acme', created.id, { retryable: true, executionResultCode: 'UPSTREAM_TIMEOUT' }, NOW);
    expect(result?.status).toBe('failed');
    expect(result?.retryable).toBe(true);
    expect(result?.active).toBe(true); // still blocks a second active approval for this order
    expect(result?.decidedAt).toBeNull(); // nothing is actually decided yet
  });

  it('executing -> failed, non-retryable (definitive upstream outcome) becomes inactive and decided', async () => {
    const repo = new InMemoryApprovalRepository();
    const created = await createPending(repo);
    await repo.beginExecution('acme', created.id, [], NOW);
    const result = await repo.markFailed('acme', created.id, { retryable: false, executionResultCode: 'ALREADY_REFUNDED_UPSTREAM' }, NOW);
    expect(result?.retryable).toBe(false);
    expect(result?.active).toBe(false);
    expect(result?.decidedAt).toEqual(NOW);
  });

  it('never re-fails an already-terminal row (e.g. executed)', async () => {
    const repo = new InMemoryApprovalRepository();
    const created = await createPending(repo);
    await repo.beginExecution('acme', created.id, [], NOW);
    await repo.markExecuted('acme', created.id, 'OK', NOW);
    expect(await repo.markFailed('acme', created.id, { retryable: false }, NOW)).toBeNull();
  });
});

describe('InMemoryApprovalRepository.reject', () => {
  it('pending -> rejected', async () => {
    const repo = new InMemoryApprovalRepository();
    const created = await createPending(repo);
    const result = await repo.reject('acme', created.id, 'key_1', NOW);
    expect(result?.status).toBe('rejected');
    expect(result?.active).toBe(false);
    expect(result?.decidedBy).toBe('key_1');
  });

  it('failed non-retryable -> rejected (for the audit trail)', async () => {
    const repo = new InMemoryApprovalRepository();
    const created = await createPending(repo);
    await repo.beginExecution('acme', created.id, [], NOW);
    await repo.markFailed('acme', created.id, { retryable: false, executionResultCode: 'ALREADY_REFUNDED_UPSTREAM' }, NOW);
    const result = await repo.reject('acme', created.id, 'key_1', NOW);
    expect(result?.status).toBe('rejected');
  });

  it('amendment A: reject is BLOCKED on a failed-retryable (ambiguous) row', async () => {
    const repo = new InMemoryApprovalRepository();
    const created = await createPending(repo);
    await repo.beginExecution('acme', created.id, [], NOW);
    await repo.markFailed('acme', created.id, { retryable: true, executionResultCode: 'UPSTREAM_TIMEOUT' }, NOW);
    expect(await repo.reject('acme', created.id, 'key_1', NOW)).toBeNull();
  });

  it('never rejects a row that is currently executing', async () => {
    const repo = new InMemoryApprovalRepository();
    const created = await createPending(repo);
    await repo.beginExecution('acme', created.id, [], NOW);
    expect(await repo.reject('acme', created.id, 'key_1', NOW)).toBeNull();
  });

  it('lost race: two reject attempts on the same pending row - only the first wins', async () => {
    const repo = new InMemoryApprovalRepository();
    const created = await createPending(repo);
    const first = await repo.reject('acme', created.id, 'key_1', NOW);
    const second = await repo.reject('acme', created.id, 'key_2', NOW);
    expect(first).not.toBeNull();
    expect(second).toBeNull();
  });
});

describe('InMemoryApprovalRepository.expire', () => {
  it('pending and past expiresAt -> expired', async () => {
    const repo = new InMemoryApprovalRepository();
    const created = await createPending(repo, { approvalExpiryDays: 7 });
    const wellAfterExpiry = new Date(created.expiresAt.getTime() + 1);
    const result = await repo.expire('acme', created.id, wellAfterExpiry);
    expect(result?.status).toBe('expired');
    expect(result?.active).toBe(false);
  });

  it('never expires a row that has not yet reached expiresAt', async () => {
    const repo = new InMemoryApprovalRepository();
    const created = await createPending(repo, { approvalExpiryDays: 7 });
    expect(await repo.expire('acme', created.id, NOW)).toBeNull();
  });

  it('never expires a non-pending row (e.g. already executing)', async () => {
    const repo = new InMemoryApprovalRepository();
    const created = await createPending(repo, { approvalExpiryDays: 7 });
    await repo.beginExecution('acme', created.id, [], NOW);
    const wellAfterExpiry = new Date(created.expiresAt.getTime() + 1);
    expect(await repo.expire('acme', created.id, wellAfterExpiry)).toBeNull();
  });

  it('lost race: approve wins the race against an expire attempt arriving a moment later', async () => {
    const repo = new InMemoryApprovalRepository();
    const created = await createPending(repo, { approvalExpiryDays: 7 });
    const wellAfterExpiry = new Date(created.expiresAt.getTime() + 1);
    const approved = await repo.beginExecution('acme', created.id, [], wellAfterExpiry);
    const expired = await repo.expire('acme', created.id, wellAfterExpiry);
    expect(approved).not.toBeNull();
    expect(expired).toBeNull();
  });
});

describe('InMemoryApprovalRepository.list', () => {
  it('filters by tenant and status, newest first', async () => {
    const repo = new InMemoryApprovalRepository();
    await createPending(repo, { orderId: 'ORD-1001', now: new Date('2026-11-01T00:00:00.000Z') });
    const second = await createPending(repo, { orderId: 'ORD-1002', now: new Date('2026-11-02T00:00:00.000Z') });
    await createPending(repo, { tenantId: 'globex', orderId: 'ORD-9999' });

    const { approvals } = await repo.list('acme', {});
    expect(approvals).toHaveLength(2);
    expect(approvals[0].id).toBe(second.id); // newest first
  });

  it('paginates with a stable cursor, never returning more than the hard cap', async () => {
    const repo = new InMemoryApprovalRepository();
    for (let i = 0; i < 5; i++) {
      await createPending(repo, { orderId: `ORD-100${i}`, now: new Date(NOW.getTime() + i * 1000) });
    }

    const page1 = await repo.list('acme', { limit: 2 });
    expect(page1.approvals).toHaveLength(2);
    expect(page1.nextCursor).toBeDefined();

    const page2 = await repo.list('acme', { limit: 2, cursor: page1.nextCursor });
    expect(page2.approvals).toHaveLength(2);
    expect(page2.approvals.map((a) => a.id)).not.toContain(page1.approvals[0].id);

    const page3 = await repo.list('acme', { limit: 2, cursor: page2.nextCursor });
    expect(page3.approvals).toHaveLength(1);
    expect(page3.nextCursor).toBeUndefined();
  });
});

describe('InMemoryApprovalRepository.countForCustomerToday', () => {
  it('counts only rows created within the same UTC calendar day', async () => {
    const repo = new InMemoryApprovalRepository();
    await createPending(repo, { customerRef: 'cust_1', now: new Date('2026-11-09T01:00:00.000Z') });
    await createPending(repo, { customerRef: 'cust_1', now: new Date('2026-11-09T23:00:00.000Z') });
    await createPending(repo, { customerRef: 'cust_1', now: new Date('2026-11-10T00:00:01.000Z') }); // next UTC day
    await createPending(repo, { customerRef: 'cust_2', now: new Date('2026-11-09T12:00:00.000Z') }); // different customer

    const count = await repo.countForCustomerToday('acme', 'cust_1', new Date('2026-11-09T18:00:00.000Z'));
    expect(count).toBe(2);
  });
});
