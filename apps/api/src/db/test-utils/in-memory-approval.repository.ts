import { randomBytes } from 'node:crypto';
import { ExecutionResultCode, VerifierFailureCode } from '@supportpilot/shared';
import {
  ApprovalListQuery,
  ApprovalListResult,
  ApprovalRecord,
  ApprovalRepository,
  encodeCursor,
  endOfUtcDay,
  resolveListLimit,
  startOfUtcDay,
  NewApproval,
} from '../../approvals/approval.repository';
import { RuleVerdictSubdocument } from '../../approvals/schemas/approval.schema';

/**
 * Behavioral twin of MongooseApprovalRepository, for fast unit tests of
 * every transition (including every lost-race case) without a database.
 * Because this process is single-threaded, "two concurrent calls" is
 * simulated by calling a transition method twice in a row and asserting
 * the second sees the already-changed state - the exact same outcome a
 * real findOneAndUpdate race produces (whichever write lands first wins;
 * the second's match condition no longer applies), just without needing
 * real concurrency to prove it.
 */
export class InMemoryApprovalRepository implements ApprovalRepository {
  private readonly approvals = new Map<string, ApprovalRecord>();

  async create(input: NewApproval): Promise<ApprovalRecord> {
    const id = randomBytes(12).toString('hex'); // same shape as a real ObjectId.toHexString()
    const idempotencyKey = `apr_${id}`;
    const expiresAt = new Date(input.now.getTime() + input.approvalExpiryDays * 24 * 60 * 60 * 1000);
    const record: ApprovalRecord = {
      id,
      tenantId: input.tenantId,
      runId: input.runId,
      conversationId: input.conversationId,
      orderId: input.orderId,
      customerRef: input.customerRef,
      amountCents: input.amountCents,
      citations: input.citations,
      status: 'pending',
      retryable: null,
      active: true,
      verifierVerdictAtProposal: input.verifierVerdictAtProposal,
      verifierVerdictAtDecision: null,
      idempotencyKey,
      attemptCount: 0,
      executionStartedAt: null,
      executingSince: null,
      decidedBy: null,
      decidedAt: null,
      reasonCode: null,
      executionResultCode: null,
      expiresAt,
      createdAt: input.now,
      updatedAt: input.now,
    };
    this.approvals.set(id, record);
    return { ...record };
  }

  async findById(tenantId: string, id: string): Promise<ApprovalRecord | null> {
    const record = this.approvals.get(id);
    if (!record || record.tenantId !== tenantId) {
      return null;
    }
    return { ...record };
  }

  async list(tenantId: string, query: ApprovalListQuery): Promise<ApprovalListResult> {
    const limit = resolveListLimit(query.limit);
    const all = [...this.approvals.values()]
      .filter((a) => a.tenantId === tenantId && (!query.status || a.status === query.status))
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || (a.id < b.id ? 1 : -1));

    const filtered = query.cursor ? applyCursorFilter(all, query.cursor) : all;
    const page = filtered.slice(0, limit).map((a) => ({ ...a }));
    const hasMore = filtered.length > limit;
    return { approvals: page, ...(hasMore && page.length > 0 ? { nextCursor: encodeCursor(page[page.length - 1]) } : {}) };
  }

  async countForCustomerToday(tenantId: string, customerRef: string, now: Date): Promise<number> {
    const start = startOfUtcDay(now);
    const end = endOfUtcDay(now);
    return [...this.approvals.values()].filter(
      (a) => a.tenantId === tenantId && a.customerRef === customerRef && a.createdAt >= start && a.createdAt < end,
    ).length;
  }

  async beginExecution(tenantId: string, id: string, verifierVerdictAtDecision: RuleVerdictSubdocument[], now: Date): Promise<ApprovalRecord | null> {
    const record = this.get(tenantId, id);
    if (!record || record.status !== 'pending') {
      return null;
    }
    record.status = 'executing';
    record.executingSince = now;
    record.executionStartedAt = now;
    record.attemptCount = 1;
    record.verifierVerdictAtDecision = verifierVerdictAtDecision;
    record.updatedAt = now;
    return { ...record };
  }

  async takeOverStuckExecution(tenantId: string, id: string, staleExecutingSince: Date, now: Date): Promise<ApprovalRecord | null> {
    const record = this.get(tenantId, id);
    if (!record || record.status !== 'executing' || record.executingSince?.getTime() !== staleExecutingSince.getTime()) {
      return null;
    }
    record.executingSince = now;
    record.attemptCount += 1;
    record.updatedAt = now;
    return { ...record };
  }

  async retryFromFailed(tenantId: string, id: string, now: Date): Promise<ApprovalRecord | null> {
    const record = this.get(tenantId, id);
    if (!record || record.status !== 'failed' || record.retryable !== true) {
      return null;
    }
    record.status = 'executing';
    record.executingSince = now;
    record.attemptCount += 1;
    record.updatedAt = now;
    return { ...record };
  }

  async markExecuted(tenantId: string, id: string, executionResultCode: ExecutionResultCode, now: Date): Promise<ApprovalRecord | null> {
    const record = this.get(tenantId, id);
    if (!record || record.status !== 'executing') {
      return null;
    }
    record.status = 'executed';
    record.active = false;
    record.executionResultCode = executionResultCode;
    record.decidedAt = now;
    record.updatedAt = now;
    return { ...record };
  }

  async markFailed(
    tenantId: string,
    id: string,
    params: { retryable: boolean; executionResultCode?: ExecutionResultCode; reasonCode?: VerifierFailureCode; verifierVerdictAtDecision?: RuleVerdictSubdocument[] },
    now: Date,
  ): Promise<ApprovalRecord | null> {
    const record = this.get(tenantId, id);
    if (!record || (record.status !== 'pending' && record.status !== 'executing')) {
      return null;
    }
    record.status = 'failed';
    record.retryable = params.retryable;
    record.active = params.retryable;
    if (params.executionResultCode !== undefined) {
      record.executionResultCode = params.executionResultCode;
    }
    if (params.reasonCode !== undefined) {
      record.reasonCode = params.reasonCode;
    }
    if (params.verifierVerdictAtDecision !== undefined) {
      record.verifierVerdictAtDecision = params.verifierVerdictAtDecision;
    }
    if (!params.retryable) {
      record.decidedAt = now;
    }
    record.updatedAt = now;
    return { ...record };
  }

  async reject(tenantId: string, id: string, decidedBy: string, now: Date): Promise<ApprovalRecord | null> {
    const record = this.get(tenantId, id);
    if (!record) {
      return null;
    }
    const allowed = record.status === 'pending' || (record.status === 'failed' && record.retryable === false);
    if (!allowed) {
      return null;
    }
    record.status = 'rejected';
    record.active = false;
    record.decidedBy = decidedBy;
    record.decidedAt = now;
    record.updatedAt = now;
    return { ...record };
  }

  async expire(tenantId: string, id: string, now: Date): Promise<ApprovalRecord | null> {
    const record = this.get(tenantId, id);
    if (!record || record.status !== 'pending' || record.expiresAt.getTime() > now.getTime()) {
      return null;
    }
    record.status = 'expired';
    record.active = false;
    record.updatedAt = now;
    return { ...record };
  }

  /** Test-only convenience: seed a record directly (e.g. to construct an "already executing" fixture) without going through the normal transition methods. */
  seed(record: ApprovalRecord): void {
    this.approvals.set(record.id, { ...record });
  }

  private get(tenantId: string, id: string): ApprovalRecord | undefined {
    const record = this.approvals.get(id);
    return record && record.tenantId === tenantId ? record : undefined;
  }
}

/** Mirrors buildListFilter's own "strictly before the last-seen row" cutoff, under the same descending (createdAt, id) sort - re-derived here directly over the in-memory array rather than reusing a Mongo query object. */
function applyCursorFilter(sorted: ApprovalRecord[], cursor: string): ApprovalRecord[] {
  const index = sorted.findIndex((a) => encodeCursor(a) === cursor);
  return index === -1 ? sorted : sorted.slice(index + 1);
}
