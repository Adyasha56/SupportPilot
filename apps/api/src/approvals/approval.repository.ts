import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import {
  DEFAULT_APPROVAL_LIST_LIMIT,
  ExecutionResultCode,
  MAX_APPROVAL_LIST_LIMIT,
  RefundExecutionFailureClass,
  VerifierFailureCode,
} from '@supportpilot/shared';
import { ApprovalDocument, ApprovalStatusValue, RuleVerdictSubdocument } from './schemas/approval.schema';

export interface ApprovalRecord {
  id: string;
  tenantId: string;
  runId: string;
  conversationId: string;
  orderId: string;
  customerRef: string;
  amountCents: number;
  citations: string[];
  status: ApprovalStatusValue;
  retryable: boolean | null;
  active: boolean;
  upstreamMaybeReceived: boolean | null;
  failureClass: RefundExecutionFailureClass | null;
  verifierVerdictAtProposal: RuleVerdictSubdocument[];
  verifierVerdictAtDecision: RuleVerdictSubdocument[] | null;
  idempotencyKey: string;
  attemptCount: number;
  executionStartedAt: Date | null;
  executingSince: Date | null;
  decidedBy: string | null;
  decidedAt: Date | null;
  reasonCode: VerifierFailureCode | null;
  executionResultCode: ExecutionResultCode | null;
  expiresAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

/** Everything the caller (ApprovalService) decides at proposal time - id/idempotencyKey/status/active/attemptCount are NOT inputs, they're computed here (amendment G). */
export interface NewApproval {
  tenantId: string;
  runId: string;
  conversationId: string;
  orderId: string;
  customerRef: string;
  amountCents: number;
  citations: string[];
  verifierVerdictAtProposal: RuleVerdictSubdocument[];
  /** Caller supplies `now` (injected clock) and the tenant's own approvalExpiryDays - this repository does no settings lookups of its own. */
  now: Date;
  approvalExpiryDays: number;
}

export interface ApprovalListQuery {
  status?: ApprovalStatusValue;
  limit?: number;
  /** Opaque - callers pass back exactly what a previous list() call returned in nextCursor. */
  cursor?: string;
}

export interface ApprovalListResult {
  approvals: ApprovalRecord[];
  nextCursor?: string;
}

/** amendment F1 - thrown instead of a plain duplicate-key passthrough, so callers (ApprovalService) can distinguish "the active-per-order index blocked this insert" from any other create() failure without inspecting a raw Mongo error code. */
export class DuplicateActiveApprovalError extends Error {
  constructor(public readonly orderId: string) {
    super(`An active Approval already exists for order "${orderId}".`);
  }
}

/** amendment F4 - params a failed execution attempt (or a pending-time verifier denial) is recorded with. `active`/`retryable` are independent (NEEDS_RECONCILIATION sets retryable: false but active: true). */
export interface MarkFailedParams {
  retryable: boolean;
  active: boolean;
  executionResultCode?: ExecutionResultCode;
  upstreamMaybeReceived?: boolean;
  failureClass?: RefundExecutionFailureClass;
  /** Pending-time verifier denial only - a single-code summary; the full detail lives in verifierVerdictAtDecision. */
  reasonCode?: VerifierFailureCode;
  verifierVerdictAtDecision?: RuleVerdictSubdocument[];
}

/**
 * Every method is tenant-scoped - tenantId is a required, explicit
 * parameter everywhere, never optional and never inferred (RULES.md
 * §5's "every database query... must be scoped by tenantId", restated
 * here as a type-level guarantee as well as a runtime one).
 *
 * Every transition method is a SINGLE atomic findOneAndUpdate matching
 * tenantId + id + the expected prior state - `markExecuted`/`markFailed`
 * additionally match `expectedAttemptCount` (amendment F1's fencing
 * token), since status alone can't distinguish a stale attempt from the
 * current one once a lease takeover has moved attemptCount forward while
 * status stays 'executing' throughout. A `null` result means the expected
 * prior state didn't match (lost a race, already decided, wrong tenant,
 * stale attempt, or doesn't exist) - none of them ever throw for that;
 * the caller is what turns a null into the right response.
 */
export interface ApprovalRepository {
  /**
   * The dual-write-with-AgentRun transaction hook point (amendment D).
   * `session` is accepted so the eventual caller can pass a Mongoose
   * ClientSession and have this insert participate in that transaction;
   * omitted, it's a plain standalone insert. Throws DuplicateActiveApprovalError
   * (amendment F2) when the active-per-order partial unique index rejects
   * the insert - never a raw Mongo E11000 error - so ApprovalService can
   * react without inspecting driver-specific error shapes.
   */
  create(input: NewApproval, session?: unknown): Promise<ApprovalRecord>;
  findById(tenantId: string, id: string): Promise<ApprovalRecord | null>;
  /** amendment F2 - the row (if any) currently blocking a new proposal for this order, so the caller can decide whether it's actually still active or just a stale pending row past its expiry. */
  findActiveByOrder(tenantId: string, orderId: string): Promise<ApprovalRecord | null>;
  list(tenantId: string, query: ApprovalListQuery): Promise<ApprovalListResult>;
  /** UTC calendar day containing `now` - see startOfUtcDay's own doc comment for why UTC, not server-local or the customer's own timezone. */
  countForCustomerToday(tenantId: string, customerRef: string, now: Date): Promise<number>;

  /** pending -> executing. First-ever attempt only - sets executionStartedAt, executingSince=now, attemptCount=1. */
  beginExecution(tenantId: string, id: string, verifierVerdictAtDecision: RuleVerdictSubdocument[], now: Date): Promise<ApprovalRecord | null>;
  /** executing (matching the exact stale executingSince just read) -> executing, refreshed. The lease-steal, amendment B - never matches a row whose lease hasn't expired, because the caller only calls this after confirming that itself. */
  takeOverStuckExecution(tenantId: string, id: string, staleExecutingSince: Date, now: Date): Promise<ApprovalRecord | null>;
  /** failed (retryable only) -> executing, refreshed. No re-verification (amendment A) - the caller never re-runs the verifier for this path. */
  retryFromFailed(tenantId: string, id: string, now: Date): Promise<ApprovalRecord | null>;
  /**
   * executing -> executed. Fenced on `expectedAttemptCount` (amendment F1):
   * a stale attempt (superseded by a lease takeover) matches nothing and
   * returns null - see this file's "stale success" doc comment on the
   * Mongoose implementation for how that's reconciled.
   */
  markExecuted(tenantId: string, id: string, expectedAttemptCount: number, now: Date): Promise<ApprovalRecord | null>;
  /**
   * pending OR executing -> failed, fenced on `expectedAttemptCount` when
   * leaving 'executing' (a pending-time verifier denial has attemptCount
   * 0 and no concurrent attempt to fence against). `params.active` is set
   * directly by the caller, independent of `retryable` - NEEDS_RECONCILIATION
   * is `retryable: false, active: true`.
   */
  markFailed(tenantId: string, id: string, expectedAttemptCount: number, params: MarkFailedParams, now: Date): Promise<ApprovalRecord | null>;
  /** pending, OR failed+(DEFINITIVE or NOT_SENT) -> rejected. Blocked for AMBIGUOUS and NEEDS_RECONCILIATION regardless of `retryable` (NOT_SENT is retryable AND rejectable at once - amendment F4). */
  reject(tenantId: string, id: string, decidedBy: string, now: Date): Promise<ApprovalRecord | null>;
  /** pending (and already past expiresAt) -> expired. */
  expire(tenantId: string, id: string, now: Date): Promise<ApprovalRecord | null>;
}

export const APPROVAL_REPOSITORY = Symbol('APPROVAL_REPOSITORY');

/**
 * Midnight UTC on the same calendar day as `date` - UTC, not server-local
 * time or any customer's own timezone, because "today" must mean the same
 * fixed window for every tenant/customer regardless of where the server
 * or the customer happens to be, and must be reproducible from the
 * injected clock alone (no Intl/timezone-database dependency).
 */
export function startOfUtcDay(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

export function endOfUtcDay(date: Date): Date {
  const start = startOfUtcDay(date);
  return new Date(start.getTime() + 24 * 60 * 60 * 1000);
}

interface CursorPayload {
  createdAt: string;
  id: string;
}

export function encodeCursor(doc: Pick<ApprovalRecord, 'createdAt' | 'id'>): string {
  const payload: CursorPayload = { createdAt: doc.createdAt.toISOString(), id: doc.id };
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

/** Returns undefined for a malformed/tampered cursor rather than throwing - list() then just starts from the beginning, the same safe behavior as any other invalid-but-non-security-sensitive cursor. */
export function decodeCursor(cursor: string): CursorPayload | undefined {
  try {
    const payload = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as Partial<CursorPayload>;
    if (typeof payload.createdAt !== 'string' || typeof payload.id !== 'string') {
      return undefined;
    }
    return { createdAt: payload.createdAt, id: payload.id };
  } catch {
    return undefined;
  }
}

/**
 * The stable, descending (createdAt, _id) keyset-pagination filter - sort
 * is always { createdAt: -1, _id: -1 }, so this is the standard
 * "strictly before the last seen row" predicate for that sort order, safe
 * even when multiple rows share the same createdAt millisecond.
 */
export function buildListFilter(tenantId: string, query: ApprovalListQuery): Record<string, unknown> {
  const filter: Record<string, unknown> = { tenantId };
  if (query.status) {
    filter.status = query.status;
  }
  if (query.cursor) {
    const decoded = decodeCursor(query.cursor);
    if (decoded) {
      const createdAt = new Date(decoded.createdAt);
      filter.$or = [{ createdAt: { $lt: createdAt } }, { createdAt, _id: { $lt: new Types.ObjectId(decoded.id) } }];
    }
  }
  return filter;
}

export function resolveListLimit(limit: number | undefined): number {
  if (limit === undefined) {
    return DEFAULT_APPROVAL_LIST_LIMIT;
  }
  return Math.min(Math.max(1, Math.trunc(limit)), MAX_APPROVAL_LIST_LIMIT);
}

function toApprovalRecord(doc: ApprovalDocument): ApprovalRecord {
  return {
    id: doc._id.toString(),
    tenantId: doc.tenantId,
    runId: doc.runId,
    conversationId: doc.conversationId,
    orderId: doc.orderId,
    customerRef: doc.customerRef,
    amountCents: doc.amountCents,
    citations: doc.citations,
    status: doc.status,
    retryable: doc.retryable,
    active: doc.active,
    upstreamMaybeReceived: doc.upstreamMaybeReceived,
    failureClass: doc.failureClass,
    verifierVerdictAtProposal: doc.verifierVerdictAtProposal,
    verifierVerdictAtDecision: doc.verifierVerdictAtDecision,
    idempotencyKey: doc.idempotencyKey,
    attemptCount: doc.attemptCount,
    executionStartedAt: doc.executionStartedAt,
    executingSince: doc.executingSince,
    decidedBy: doc.decidedBy,
    decidedAt: doc.decidedAt,
    reasonCode: doc.reasonCode,
    executionResultCode: doc.executionResultCode,
    expiresAt: doc.expiresAt,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
}

function isDuplicateKeyError(err: unknown): boolean {
  return typeof err === 'object' && err !== null && 'code' in err && (err as { code: unknown }).code === 11000;
}

@Injectable()
export class MongooseApprovalRepository implements ApprovalRepository {
  constructor(@InjectModel('Approval') private readonly model: Model<ApprovalDocument>) {}

  async create(input: NewApproval, session?: unknown): Promise<ApprovalRecord> {
    const id = new Types.ObjectId();
    const idempotencyKey = `apr_${id.toHexString()}`;
    const expiresAt = new Date(input.now.getTime() + input.approvalExpiryDays * 24 * 60 * 60 * 1000);

    try {
      const [doc] = await this.model.create(
        [
          {
            _id: id,
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
            upstreamMaybeReceived: null,
            failureClass: null,
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
          },
        ],
        { session: session as never },
      );
      return toApprovalRecord(doc);
    } catch (err) {
      if (isDuplicateKeyError(err)) {
        throw new DuplicateActiveApprovalError(input.orderId);
      }
      throw err;
    }
  }

  async findById(tenantId: string, id: string): Promise<ApprovalRecord | null> {
    if (!Types.ObjectId.isValid(id)) {
      return null;
    }
    const doc = await this.model.findOne({ _id: id, tenantId }).lean();
    return doc ? toApprovalRecord(doc as unknown as ApprovalDocument) : null;
  }

  async findActiveByOrder(tenantId: string, orderId: string): Promise<ApprovalRecord | null> {
    const doc = await this.model.findOne({ tenantId, orderId, active: true }).lean();
    return doc ? toApprovalRecord(doc as unknown as ApprovalDocument) : null;
  }

  async list(tenantId: string, query: ApprovalListQuery): Promise<ApprovalListResult> {
    const limit = resolveListLimit(query.limit);
    const filter = buildListFilter(tenantId, query);
    // Fetch one extra row to know whether a next page exists, without a separate count query.
    const docs = (await this.model
      .find(filter)
      .sort({ createdAt: -1, _id: -1 })
      .limit(limit + 1)
      .lean()) as unknown as ApprovalDocument[];

    const page = docs.slice(0, limit).map(toApprovalRecord);
    const hasMore = docs.length > limit;
    return { approvals: page, ...(hasMore && page.length > 0 ? { nextCursor: encodeCursor(page[page.length - 1]) } : {}) };
  }

  async countForCustomerToday(tenantId: string, customerRef: string, now: Date): Promise<number> {
    return this.model.countDocuments({
      tenantId,
      customerRef,
      createdAt: { $gte: startOfUtcDay(now), $lt: endOfUtcDay(now) },
    });
  }

  async beginExecution(tenantId: string, id: string, verifierVerdictAtDecision: RuleVerdictSubdocument[], now: Date): Promise<ApprovalRecord | null> {
    if (!Types.ObjectId.isValid(id)) {
      return null;
    }
    const doc = await this.model
      .findOneAndUpdate(
        { _id: id, tenantId, status: 'pending' },
        {
          $set: {
            status: 'executing',
            executingSince: now,
            executionStartedAt: now,
            attemptCount: 1,
            verifierVerdictAtDecision,
          },
        },
        { new: true },
      )
      .lean();
    return doc ? toApprovalRecord(doc as unknown as ApprovalDocument) : null;
  }

  async takeOverStuckExecution(tenantId: string, id: string, staleExecutingSince: Date, now: Date): Promise<ApprovalRecord | null> {
    if (!Types.ObjectId.isValid(id)) {
      return null;
    }
    const doc = await this.model
      .findOneAndUpdate(
        { _id: id, tenantId, status: 'executing', executingSince: staleExecutingSince },
        { $set: { executingSince: now }, $inc: { attemptCount: 1 } },
        { new: true },
      )
      .lean();
    return doc ? toApprovalRecord(doc as unknown as ApprovalDocument) : null;
  }

  async retryFromFailed(tenantId: string, id: string, now: Date): Promise<ApprovalRecord | null> {
    if (!Types.ObjectId.isValid(id)) {
      return null;
    }
    const doc = await this.model
      .findOneAndUpdate(
        { _id: id, tenantId, status: 'failed', retryable: true },
        { $set: { status: 'executing', executingSince: now }, $inc: { attemptCount: 1 } },
        { new: true },
      )
      .lean();
    return doc ? toApprovalRecord(doc as unknown as ApprovalDocument) : null;
  }

  /**
   * Amendment F1's "stale success" case: attempt #1's own upstream call
   * eventually resolves with success, but a lease takeover already moved
   * attemptCount forward (or a different attempt already landed
   * markExecuted first) - this `findOneAndUpdate` then matches nothing and
   * returns null, exactly like any other lost race. Nothing is lost: the
   * refund itself is governed by the SAME idempotencyKey regardless of
   * which attempt's HTTP call "wins" the race to report it, so the store
   * only ever applies it once; whichever attempt's write actually lands
   * first in Mongo is what the record reflects, and the other's late,
   * fenced-out success report is correctly a no-op, not an error - the
   * caller (ApprovalService) logs it as a reconciliation-for-visibility
   * event, never retries or alarms, because the system is already in the
   * correct state (`executed`) by the time the stale report arrives.
   */
  async markExecuted(tenantId: string, id: string, expectedAttemptCount: number, now: Date): Promise<ApprovalRecord | null> {
    if (!Types.ObjectId.isValid(id)) {
      return null;
    }
    const doc = await this.model
      .findOneAndUpdate(
        { _id: id, tenantId, status: 'executing', attemptCount: expectedAttemptCount },
        { $set: { status: 'executed', active: false, executionResultCode: 'OK', decidedAt: now } },
        { new: true },
      )
      .lean();
    return doc ? toApprovalRecord(doc as unknown as ApprovalDocument) : null;
  }

  async markFailed(tenantId: string, id: string, expectedAttemptCount: number, params: MarkFailedParams, now: Date): Promise<ApprovalRecord | null> {
    if (!Types.ObjectId.isValid(id)) {
      return null;
    }
    const $set: Record<string, unknown> = {
      status: 'failed',
      retryable: params.retryable,
      active: params.active,
    };
    if (params.executionResultCode !== undefined) {
      $set.executionResultCode = params.executionResultCode;
    }
    if (params.upstreamMaybeReceived !== undefined) {
      $set.upstreamMaybeReceived = params.upstreamMaybeReceived;
    }
    if (params.failureClass !== undefined) {
      $set.failureClass = params.failureClass;
    }
    if (params.reasonCode !== undefined) {
      $set.reasonCode = params.reasonCode;
    }
    if (params.verifierVerdictAtDecision !== undefined) {
      $set.verifierVerdictAtDecision = params.verifierVerdictAtDecision;
    }
    // A failed row that's still active (retryable, or NEEDS_RECONCILIATION) stays unresolved -
    // no decidedAt yet, matching "decidedAt is when a decision actually settled the matter."
    if (!params.active) {
      $set.decidedAt = now;
    }

    const doc = await this.model
      .findOneAndUpdate(
        { _id: id, tenantId, status: { $in: ['pending', 'executing'] }, attemptCount: expectedAttemptCount },
        { $set },
        { new: true },
      )
      .lean();
    return doc ? toApprovalRecord(doc as unknown as ApprovalDocument) : null;
  }

  async reject(tenantId: string, id: string, decidedBy: string, now: Date): Promise<ApprovalRecord | null> {
    if (!Types.ObjectId.isValid(id)) {
      return null;
    }
    const doc = await this.model
      .findOneAndUpdate(
        {
          _id: id,
          tenantId,
          $or: [{ status: 'pending' }, { status: 'failed', failureClass: { $nin: ['AMBIGUOUS', 'NEEDS_RECONCILIATION'] } }],
        },
        { $set: { status: 'rejected', active: false, decidedBy, decidedAt: now } },
        { new: true },
      )
      .lean();
    return doc ? toApprovalRecord(doc as unknown as ApprovalDocument) : null;
  }

  async expire(tenantId: string, id: string, now: Date): Promise<ApprovalRecord | null> {
    if (!Types.ObjectId.isValid(id)) {
      return null;
    }
    const doc = await this.model
      .findOneAndUpdate(
        { _id: id, tenantId, status: 'pending', expiresAt: { $lte: now } },
        { $set: { status: 'expired', active: false } },
        { new: true },
      )
      .lean();
    return doc ? toApprovalRecord(doc as unknown as ApprovalDocument) : null;
  }
}
