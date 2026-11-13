import { describe, expect, it } from 'vitest';
import { DuplicateActiveApprovalError, NewApproval } from '../../approvals/approval.repository';
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

  it('amendment F2: a second proposal for an order that already has an active approval throws DuplicateActiveApprovalError', async () => {
    const repo = new InMemoryApprovalRepository();
    await createPending(repo, { orderId: 'ORD-1001' });
    await expect(createPending(repo, { orderId: 'ORD-1001' })).rejects.toBeInstanceOf(DuplicateActiveApprovalError);
  });

  it('a second proposal for the same order succeeds once the first is no longer active', async () => {
    const repo = new InMemoryApprovalRepository();
    const first = await createPending(repo, { orderId: 'ORD-1001' });
    await repo.reject('acme', first.id, 'key_1', NOW);
    const second = await createPending(repo, { orderId: 'ORD-1001' });
    expect(second.id).not.toBe(first.id);
  });
});

describe('InMemoryApprovalRepository.findActiveByOrder (amendment F2)', () => {
  it('finds the active row for an order', async () => {
    const repo = new InMemoryApprovalRepository();
    const created = await createPending(repo, { orderId: 'ORD-1001' });
    const found = await repo.findActiveByOrder('acme', 'ORD-1001');
    expect(found?.id).toBe(created.id);
  });

  it('returns null once the row is no longer active', async () => {
    const repo = new InMemoryApprovalRepository();
    const created = await createPending(repo, { orderId: 'ORD-1001' });
    await repo.reject('acme', created.id, 'key_1', NOW);
    expect(await repo.findActiveByOrder('acme', 'ORD-1001')).toBeNull();
  });

  it('returns null for an order with no approval at all', async () => {
    const repo = new InMemoryApprovalRepository();
    expect(await repo.findActiveByOrder('acme', 'ORD-9999')).toBeNull();
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

  // Stage 5 follow-up (CI failure fix): decidedBy is optional and appended LAST specifically so
  // every pre-existing 4-arg call above keeps compiling and keeps its exact prior behavior.
  it('records decidedBy when the caller passes it (e.g. "system:auto_execute")', async () => {
    const repo = new InMemoryApprovalRepository();
    const created = await createPending(repo);
    const result = await repo.beginExecution('acme', created.id, [], NOW, 'system:auto_execute');
    expect(result?.decidedBy).toBe('system:auto_execute');
  });

  it('leaves decidedBy exactly as it already was when the caller omits it', async () => {
    const repo = new InMemoryApprovalRepository();
    const created = await createPending(repo);
    expect(created.decidedBy).toBeNull();
    const result = await repo.beginExecution('acme', created.id, [], NOW);
    expect(result?.decidedBy).toBeNull();
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
    await repo.markFailed('acme', created.id, 1, { retryable: true, active: true, executionResultCode: 'TIMEOUT', failureClass: 'AMBIGUOUS', upstreamMaybeReceived: true }, NOW);
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
    await repo.markFailed('acme', created.id, 1, { retryable: false, active: false, executionResultCode: 'NOT_FOUND', failureClass: 'DEFINITIVE', upstreamMaybeReceived: false }, NOW);

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

describe('InMemoryApprovalRepository.markExecuted (amendment F1 fencing)', () => {
  it('executing -> executed, active: false, executionResultCode OK, when attemptCount matches', async () => {
    const repo = new InMemoryApprovalRepository();
    const created = await createPending(repo);
    const begun = await repo.beginExecution('acme', created.id, [], NOW);

    const result = await repo.markExecuted('acme', created.id, begun!.attemptCount, NOW);
    expect(result?.status).toBe('executed');
    expect(result?.active).toBe(false);
    expect(result?.executionResultCode).toBe('OK');
  });

  it('never executes a row that is not currently executing (e.g. still pending)', async () => {
    const repo = new InMemoryApprovalRepository();
    const created = await createPending(repo);
    expect(await repo.markExecuted('acme', created.id, 0, NOW)).toBeNull();
  });

  it('a STALE markExecuted (wrong attemptCount, after a lease takeover already moved it forward) does nothing', async () => {
    const repo = new InMemoryApprovalRepository();
    const created = await createPending(repo);
    const begun = await repo.beginExecution('acme', created.id, [], NOW); // attemptCount 1
    await repo.takeOverStuckExecution('acme', created.id, begun!.executingSince!, new Date(NOW.getTime() + 120_000)); // attemptCount 2 now

    // Attempt #1's own late success report still carries its OWN original attemptCount (1).
    const staleResult = await repo.markExecuted('acme', created.id, 1, NOW);
    expect(staleResult).toBeNull();

    // The row is untouched by the stale call - still executing, at the NEW attempt.
    const current = await repo.findById('acme', created.id);
    expect(current?.status).toBe('executing');
    expect(current?.attemptCount).toBe(2);
  });

  it('a stale markExecuted after the CURRENT attempt already succeeded is a safe no-op - the record already reflects the truth', async () => {
    const repo = new InMemoryApprovalRepository();
    const created = await createPending(repo);
    const begun = await repo.beginExecution('acme', created.id, [], NOW);
    await repo.takeOverStuckExecution('acme', created.id, begun!.executingSince!, new Date(NOW.getTime() + 120_000)); // now attemptCount 2
    const executedByAttempt2 = await repo.markExecuted('acme', created.id, 2, NOW);
    expect(executedByAttempt2?.status).toBe('executed');

    // Attempt #1's late, stale success report - fenced out, but harmless, because attempt #2's
    // (or the store's idempotent replay of attempt #1's own request) already recorded the truth.
    const staleResult = await repo.markExecuted('acme', created.id, 1, NOW);
    expect(staleResult).toBeNull();
    const finalState = await repo.findById('acme', created.id);
    expect(finalState?.status).toBe('executed'); // still correctly executed, exactly once
  });

  it('lost race: a row already marked executed can never be marked executed again, even with the right attemptCount', async () => {
    const repo = new InMemoryApprovalRepository();
    const created = await createPending(repo);
    const begun = await repo.beginExecution('acme', created.id, [], NOW);
    const first = await repo.markExecuted('acme', created.id, begun!.attemptCount, NOW);
    const second = await repo.markExecuted('acme', created.id, begun!.attemptCount, NOW);
    expect(first).not.toBeNull();
    expect(second).toBeNull();
  });
});

describe('InMemoryApprovalRepository.markFailed (amendments F1/F4)', () => {
  it('pending -> failed, non-retryable, when the decision-time verifier re-check itself fails (no upstream attempt made)', async () => {
    const repo = new InMemoryApprovalRepository();
    const created = await createPending(repo);
    const result = await repo.markFailed(
      'acme',
      created.id,
      0,
      { retryable: false, active: false, reasonCode: 'ORDER_STATUS_INELIGIBLE', verifierVerdictAtDecision: [{ code: 'ORDER_STATUS_INELIGIBLE', passed: false }] },
      NOW,
    );
    expect(result?.status).toBe('failed');
    expect(result?.retryable).toBe(false);
    expect(result?.active).toBe(false); // non-retryable denial is terminal
    expect(result?.reasonCode).toBe('ORDER_STATUS_INELIGIBLE');
    expect(result?.attemptCount).toBe(0); // no execution was ever attempted
  });

  it('executing -> failed, AMBIGUOUS, stays active, fenced on attemptCount', async () => {
    const repo = new InMemoryApprovalRepository();
    const created = await createPending(repo);
    const begun = await repo.beginExecution('acme', created.id, [], NOW);
    const result = await repo.markFailed(
      'acme',
      created.id,
      begun!.attemptCount,
      { retryable: true, active: true, executionResultCode: 'TIMEOUT', failureClass: 'AMBIGUOUS', upstreamMaybeReceived: true },
      NOW,
    );
    expect(result?.status).toBe('failed');
    expect(result?.retryable).toBe(true);
    expect(result?.active).toBe(true);
    expect(result?.upstreamMaybeReceived).toBe(true);
    expect(result?.decidedAt).toBeNull(); // nothing is actually decided yet
  });

  it('executing -> failed, DEFINITIVE, becomes inactive and decided', async () => {
    const repo = new InMemoryApprovalRepository();
    const created = await createPending(repo);
    const begun = await repo.beginExecution('acme', created.id, [], NOW);
    const result = await repo.markFailed(
      'acme',
      created.id,
      begun!.attemptCount,
      { retryable: false, active: false, executionResultCode: 'NOT_FOUND', failureClass: 'DEFINITIVE', upstreamMaybeReceived: false },
      NOW,
    );
    expect(result?.retryable).toBe(false);
    expect(result?.active).toBe(false);
    expect(result?.decidedAt).toEqual(NOW);
  });

  it('executing -> failed, NEEDS_RECONCILIATION (a retry-time CONFLICT): not retryable, but STAYS active and undecided', async () => {
    const repo = new InMemoryApprovalRepository();
    const created = await createPending(repo);
    const begun = await repo.beginExecution('acme', created.id, [], NOW);
    const result = await repo.markFailed(
      'acme',
      created.id,
      begun!.attemptCount,
      { retryable: false, active: true, executionResultCode: 'CONFLICT', failureClass: 'NEEDS_RECONCILIATION', upstreamMaybeReceived: true },
      NOW,
    );
    expect(result?.retryable).toBe(false);
    expect(result?.active).toBe(true); // still blocks a fresh proposal for this order - the money likely already moved
    expect(result?.decidedAt).toBeNull(); // not a settled decision - needs a human
  });

  it('a STALE markFailed (wrong attemptCount, after a lease takeover) does nothing', async () => {
    const repo = new InMemoryApprovalRepository();
    const created = await createPending(repo);
    const begun = await repo.beginExecution('acme', created.id, [], NOW);
    await repo.takeOverStuckExecution('acme', created.id, begun!.executingSince!, new Date(NOW.getTime() + 120_000));

    const staleResult = await repo.markFailed('acme', created.id, 1, { retryable: true, active: true, executionResultCode: 'TIMEOUT' }, NOW);
    expect(staleResult).toBeNull();
    const current = await repo.findById('acme', created.id);
    expect(current?.status).toBe('executing');
    expect(current?.attemptCount).toBe(2);
  });

  it('never re-fails an already-terminal row (e.g. executed)', async () => {
    const repo = new InMemoryApprovalRepository();
    const created = await createPending(repo);
    const begun = await repo.beginExecution('acme', created.id, [], NOW);
    await repo.markExecuted('acme', created.id, begun!.attemptCount, NOW);
    expect(await repo.markFailed('acme', created.id, begun!.attemptCount, { retryable: false, active: false }, NOW)).toBeNull();
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

  it('failed non-retryable (DEFINITIVE) -> rejected (for the audit trail)', async () => {
    const repo = new InMemoryApprovalRepository();
    const created = await createPending(repo);
    const begun = await repo.beginExecution('acme', created.id, [], NOW);
    await repo.markFailed('acme', created.id, begun!.attemptCount, { retryable: false, active: false, executionResultCode: 'NOT_FOUND', failureClass: 'DEFINITIVE' }, NOW);
    const result = await repo.reject('acme', created.id, 'key_1', NOW);
    expect(result?.status).toBe('rejected');
  });

  it('amendment A: reject is BLOCKED on a failed-retryable (AMBIGUOUS) row', async () => {
    const repo = new InMemoryApprovalRepository();
    const created = await createPending(repo);
    const begun = await repo.beginExecution('acme', created.id, [], NOW);
    await repo.markFailed('acme', created.id, begun!.attemptCount, { retryable: true, active: true, executionResultCode: 'TIMEOUT', failureClass: 'AMBIGUOUS' }, NOW);
    expect(await repo.reject('acme', created.id, 'key_1', NOW)).toBeNull();
  });

  it('amendment F4: reject is BLOCKED on a NEEDS_RECONCILIATION row, even though retryable is false there too', async () => {
    const repo = new InMemoryApprovalRepository();
    const created = await createPending(repo);
    const begun = await repo.beginExecution('acme', created.id, [], NOW);
    await repo.markFailed(
      'acme',
      created.id,
      begun!.attemptCount,
      { retryable: false, active: true, executionResultCode: 'CONFLICT', failureClass: 'NEEDS_RECONCILIATION' },
      NOW,
    );
    expect(await repo.reject('acme', created.id, 'key_1', NOW)).toBeNull();
  });

  it('amendment F4: reject IS allowed on a NOT_SENT row (retryable AND rejectable)', async () => {
    const repo = new InMemoryApprovalRepository();
    const created = await createPending(repo);
    const begun = await repo.beginExecution('acme', created.id, [], NOW);
    await repo.markFailed(
      'acme',
      created.id,
      begun!.attemptCount,
      { retryable: true, active: true, executionResultCode: 'SECRET_NOT_CONFIGURED', failureClass: 'NOT_SENT' },
      NOW,
    );
    const result = await repo.reject('acme', created.id, 'key_1', NOW);
    expect(result?.status).toBe('rejected');
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
    await createPending(repo, { orderId: 'ORD-3001', customerRef: 'cust_1', now: new Date('2026-11-09T01:00:00.000Z') });
    await createPending(repo, { orderId: 'ORD-3002', customerRef: 'cust_1', now: new Date('2026-11-09T23:00:00.000Z') });
    await createPending(repo, { orderId: 'ORD-3003', customerRef: 'cust_1', now: new Date('2026-11-10T00:00:01.000Z') }); // next UTC day
    await createPending(repo, { orderId: 'ORD-3004', customerRef: 'cust_2', now: new Date('2026-11-09T12:00:00.000Z') }); // different customer

    const count = await repo.countForCustomerToday('acme', 'cust_1', new Date('2026-11-09T18:00:00.000Z'));
    expect(count).toBe(2);
  });
});
