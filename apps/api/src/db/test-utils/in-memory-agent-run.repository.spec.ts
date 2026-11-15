import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { DuplicateAgentRunError, NewAgentRun } from '../agent-run.repository';
import { InMemoryAgentRunRepository } from './in-memory-agent-run.repository';

// A fresh runId per call by default - most tests here don't care about runId uniqueness at all,
// and reusing one fixed literal would collide with the new {tenantId, runId} uniqueness
// constraint (Stage 5 follow-up I1(b)) the moment more than one run is created for the same
// tenant. Tests that DO care about the duplicate/idempotency behavior pass an explicit runId.
function makeRun(overrides: Partial<NewAgentRun> = {}): NewAgentRun {
  return {
    tenantId: 'acme',
    runId: `run_${randomUUID()}`,
    conversationId: 'conv_1',
    outcome: 'reply',
    stepCount: 2,
    llmCallCount: 2,
    tokensIn: 100,
    tokensOut: 50,
    latencyMs: 1200,
    steps: [{ type: 'plan', durationMs: 500, outcomeCode: 'OK' }],
    ...overrides,
  };
}

describe('InMemoryAgentRunRepository', () => {
  it('creates a run, defaulting degraded, proposedAction, and refundDisposition to null when omitted', async () => {
    const repo = new InMemoryAgentRunRepository();
    const run = await repo.create(makeRun());

    expect(run.degraded).toBeNull();
    expect(run.proposedAction).toBeNull();
    expect(run.refundDisposition).toBeNull();
    expect(run.outcome).toBe('reply');
    expect(run.steps).toHaveLength(1);
  });

  it('preserves degraded and proposedAction when provided', async () => {
    const repo = new InMemoryAgentRunRepository();
    const run = await repo.create(
      makeRun({
        outcome: 'escalate',
        degraded: 'CIRCUIT_OPEN',
        proposedAction: { tool: 'issue_refund', orderId: 'ORD-1001', amount: 49.99 },
      }),
    );

    expect(run.degraded).toBe('CIRCUIT_OPEN');
    expect(run.proposedAction).toEqual({ tool: 'issue_refund', orderId: 'ORD-1001', amount: 49.99 });
  });

  it('preserves refundDisposition when provided - denied, with every failed rule code in fixed order', async () => {
    const repo = new InMemoryAgentRunRepository();
    const run = await repo.create(
      makeRun({ outcome: 'escalate', refundDisposition: { kind: 'denied', failedRuleCodes: ['ORDER_OWNERSHIP_MISMATCH', 'MISSING_POLICY_CITATION'] } }),
    );

    expect(run.refundDisposition).toEqual({ kind: 'denied', failedRuleCodes: ['ORDER_OWNERSHIP_MISMATCH', 'MISSING_POLICY_CITATION'] });
  });

  it('preserves refundDisposition when provided - pending_approval, with an approvalId', async () => {
    const repo = new InMemoryAgentRunRepository();
    const run = await repo.create(makeRun({ outcome: 'pending_approval', refundDisposition: { kind: 'pending_approval', approvalId: 'apr_123' } }));

    expect(run.refundDisposition).toEqual({ kind: 'pending_approval', approvalId: 'apr_123' });
  });

  it('findByConversation is scoped by tenant and conversation, oldest first', async () => {
    const repo = new InMemoryAgentRunRepository();
    await repo.create(makeRun({ conversationId: 'conv_1' }));
    await repo.create(makeRun({ conversationId: 'conv_1' }));
    await repo.create(makeRun({ conversationId: 'conv_2' }));
    await repo.create(makeRun({ tenantId: 'widgetco', conversationId: 'conv_1' }));

    const results = await repo.findByConversation('acme', 'conv_1');

    expect(results).toHaveLength(2);
    expect(results.every((r) => r.tenantId === 'acme' && r.conversationId === 'conv_1')).toBe(true);
  });

  it('deleteForTenant only removes that tenant\'s runs', async () => {
    const repo = new InMemoryAgentRunRepository();
    await repo.create(makeRun({ tenantId: 'acme' }));
    await repo.create(makeRun({ tenantId: 'widgetco' }));

    await repo.deleteForTenant('acme');

    expect(await repo.findByConversation('acme', 'conv_1')).toEqual([]);
    expect(await repo.findByConversation('widgetco', 'conv_1')).toHaveLength(1);
  });

  // Stage 5 follow-up I1(b)
  describe('runId uniqueness (amendment I1b)', () => {
    it('throws DuplicateAgentRunError on a second create() for the same (tenantId, runId)', async () => {
      const repo = new InMemoryAgentRunRepository();
      await repo.create(makeRun({ runId: 'run_dup' }));

      await expect(repo.create(makeRun({ runId: 'run_dup' }))).rejects.toThrow(DuplicateAgentRunError);
    });

    it('the SAME runId is allowed again for a DIFFERENT tenant', async () => {
      const repo = new InMemoryAgentRunRepository();
      await repo.create(makeRun({ tenantId: 'acme', runId: 'run_shared' }));

      await expect(repo.create(makeRun({ tenantId: 'widgetco', runId: 'run_shared' }))).resolves.toBeTruthy();
    });

    it('findByRunId returns the existing record, scoped by tenant', async () => {
      const repo = new InMemoryAgentRunRepository();
      const created = await repo.create(makeRun({ tenantId: 'acme', runId: 'run_lookup' }));

      expect(await repo.findByRunId('acme', 'run_lookup')).toEqual(created);
      expect(await repo.findByRunId('widgetco', 'run_lookup')).toBeNull();
      expect(await repo.findByRunId('acme', 'run_nonexistent')).toBeNull();
    });
  });
});
