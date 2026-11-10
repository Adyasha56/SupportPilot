import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { VerifierFailureCode } from '@supportpilot/shared';
import { buildPendingApprovalMessage } from '../agent/loop/build-pending-approval-message';
import { ToolRunErrorCode } from '../agent/tool-runner/tool-runner';
import {
  buildAlreadyUnderReviewMessage,
  buildApprovedAndExecutedMessage,
  buildAutoExecutedMessage,
  buildRejectedMessage,
  buildTerminalDenialMessage,
} from './approval-message';
import { APPROVAL_REPOSITORY, ApprovalListQuery, ApprovalListResult, ApprovalRecord, ApprovalRepository, DuplicateActiveApprovalError } from './approval.repository';
import { PrivilegedRefundRunner } from './privileged-refund-runner';
import { classifyRefundExecutionFailure } from './refund-execution-classification';
import { RefundVerifierOrderSnapshot, RefundVerifierTenantSettings, verifyRefundProposal } from './refund-verifier';

export const APPROVAL_EXECUTION_LEASE_MS_DEFAULT = 60_000;
export const AUTO_EXECUTE_TIMEOUT_MS_DEFAULT = 15_000;

export interface ApprovalServiceSettings {
  /** Amendment B - how long an `executing` row blocks a second decision attempt before a takeover is allowed. */
  executionLeaseMs: number;
  /** Amendment J - the auto-execute path's own bounded timeout, strictly inside the remaining HTTP deadline. */
  autoExecuteTimeoutMs: number;
}

const DEFAULT_SETTINGS: ApprovalServiceSettings = {
  executionLeaseMs: APPROVAL_EXECUTION_LEASE_MS_DEFAULT,
  autoExecuteTimeoutMs: AUTO_EXECUTE_TIMEOUT_MS_DEFAULT,
};

export interface CreateFromProposalInput {
  tenantId: string;
  runId: string;
  conversationId: string;
  orderId: string;
  verifiedCustomerRef: string;
  amountCents: number;
  citations: string[];
  orderSnapshot: RefundVerifierOrderSnapshot;
  tenantSettings: RefundVerifierTenantSettings;
  approvalExpiryDays: number;
  customerDailyRefundCount: number;
  now: Date;
}

export type CreateFromProposalResult =
  | { kind: 'denied'; failedRuleCodes: VerifierFailureCode[] }
  | { kind: 'already_pending'; approvalId: string; message: string }
  | { kind: 'pending_approval'; approvalId: string; message: string }
  | { kind: 'auto_executed'; approvalId: string; success: true; message: string }
  | { kind: 'auto_executed'; approvalId: string; success: false };

export type DecideErrorCode = 'NOT_FOUND' | 'EXPIRED' | 'IN_PROGRESS' | 'AMBIGUOUS_RETRY_REQUIRED' | 'ALREADY_DECIDED' | 'VERIFIER_DENIED';

export type DecideResult =
  | { ok: true; status: 'executed'; message: string }
  | { ok: true; status: 'failed'; retryable: boolean }
  | { ok: true; status: 'rejected'; message: string }
  | { ok: false; code: DecideErrorCode; failedRuleCodes?: VerifierFailureCode[] };

/** Re-fetches live order facts for the decision-time verifier re-check (amendment A) - injected so ApprovalService never hard-wires a specific tool-runner call. Returns null if the order can no longer be found/read at all. */
export type FetchFreshOrderSnapshot = (tenantId: string, orderId: string) => Promise<RefundVerifierOrderSnapshot | null>;

/** Amendment K - best-effort; a failure here never changes a decision already recorded. Optional - omitted entirely until the chat/conversation wiring stage exists. */
export type AppendCustomerMessage = (tenantId: string, conversationId: string, message: string) => Promise<void>;

function amountDollars(amountCents: number): number {
  return Math.round(amountCents) / 100;
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, onTimeout: () => T): Promise<T> {
  let timer!: ReturnType<typeof setTimeout>;
  const timeout = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(onTimeout()), timeoutMs);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

@Injectable()
export class ApprovalService {
  private readonly logger = new Logger(ApprovalService.name);
  private readonly settings: ApprovalServiceSettings;
  // Not a parameter property (a definite-assignment `!` assertion isn't valid on one) - assigned
  // in the constructor body instead, right below. @Optional() - same reasoning as
  // database.module.ts's own doc comment: this provider only exists when DatabaseModule was
  // actually imported (MONGODB_URI set). Without @Optional(), compiling ApprovalsModule with no
  // database at all (e.g. this class's own unit tests importing the module, or a future
  // environment before chat-wiring needs it for real) would throw at MODULE COMPILE time rather
  // than only failing if a method is actually called with no repository present - the same
  // "safe to import, fails at the call site" discipline every other DB-dependent service in this
  // codebase already follows. The `!` keeps every method body below typechecking normally;
  // nothing calls this class without a real repository yet.
  private readonly repository!: ApprovalRepository;

  constructor(
    @Optional() @Inject(APPROVAL_REPOSITORY) repository: ApprovalRepository,
    private readonly privilegedRefundRunner: PrivilegedRefundRunner,
    // @Optional() - a plain object type has no runtime token Nest's DI could ever resolve on its
    // own; without this, real DI wiring (ApprovalsModule) would throw trying to inject it.
    // Tests construct this class directly (`new ApprovalService(...)`), bypassing DI entirely,
    // and pass overrides there instead.
    @Optional() settings?: Partial<ApprovalServiceSettings>,
  ) {
    this.repository = repository;
    this.settings = { ...DEFAULT_SETTINGS, ...settings };
  }

  /**
   * Called whenever runAgent returns `pending_approval` with a validated
   * proposal. Resolves to one of four dispositions (amendment D) - never
   * throws for a business outcome, only for genuine infrastructure
   * failures the caller (chat.service.ts, a later stage) must still
   * handle via its own mandatory-write retry.
   */
  async createFromProposal(input: CreateFromProposalInput, appendCustomerMessage?: AppendCustomerMessage): Promise<CreateFromProposalResult> {
    const verifierResult = verifyRefundProposal({
      proposedAmountCents: input.amountCents,
      order: input.orderSnapshot,
      verifiedCustomerRef: input.verifiedCustomerRef,
      citations: input.citations,
      tenantSettings: input.tenantSettings,
      customerDailyRefundCount: input.customerDailyRefundCount,
      clock: () => input.now,
    });

    if (verifierResult.decision === 'deny') {
      return { kind: 'denied', failedRuleCodes: verifierResult.failedRuleCodes };
    }

    const created = await this.createApprovalRow(input, verifierResult.verdicts);
    if (created.kind === 'already_pending') {
      const message = buildAlreadyUnderReviewMessage(input.orderId);
      await this.safeAppend(appendCustomerMessage, input.tenantId, input.conversationId, message);
      return { kind: 'already_pending', approvalId: created.approvalId, message };
    }
    const approval = created.approval;

    if (verifierResult.decision === 'require_approval') {
      const message = buildPendingApprovalMessage(input.orderId, amountDollars(input.amountCents));
      return { kind: 'pending_approval', approvalId: approval.id, message };
    }

    // decision === 'auto_execute' - bounded, own timeout, strictly inside the remaining HTTP deadline.
    const beganApproval = await this.repository.beginExecution(input.tenantId, approval.id, verifierResult.verdicts, input.now);
    if (!beganApproval) {
      // Structurally shouldn't happen (nothing else has touched this brand-new row yet), but
      // fail closed rather than claim success if it somehow does.
      return { kind: 'auto_executed', approvalId: approval.id, success: false };
    }

    const executed = await withTimeout(
      this.executeApproval(beganApproval, input.tenantId, input.conversationId, input.now, appendCustomerMessage),
      this.settings.autoExecuteTimeoutMs,
      () => ({ ok: false as const, code: 'IN_PROGRESS' as DecideErrorCode }),
    );

    if (executed.ok && executed.status === 'executed') {
      const message = buildAutoExecutedMessage(input.orderId, amountDollars(input.amountCents));
      return { kind: 'auto_executed', approvalId: approval.id, success: true, message };
    }
    // Any failure - definitive, ambiguous, or the bounded timeout firing - NEVER claims success.
    return { kind: 'auto_executed', approvalId: approval.id, success: false };
  }

  private async createApprovalRow(
    input: CreateFromProposalInput,
    verifierVerdictAtProposal: ApprovalRecord['verifierVerdictAtProposal'],
  ): Promise<{ kind: 'created'; approval: ApprovalRecord } | { kind: 'already_pending'; approvalId: string }> {
    const attempt = () =>
      this.repository.create({
        tenantId: input.tenantId,
        runId: input.runId,
        conversationId: input.conversationId,
        orderId: input.orderId,
        customerRef: input.verifiedCustomerRef,
        amountCents: input.amountCents,
        citations: input.citations,
        verifierVerdictAtProposal,
        now: input.now,
        approvalExpiryDays: input.approvalExpiryDays,
      });

    try {
      return { kind: 'created', approval: await attempt() };
    } catch (err) {
      if (!(err instanceof DuplicateActiveApprovalError)) {
        throw err;
      }
      // Amendment F2 - the blocking row might just be a stale pending one past its own expiry.
      const blocking = await this.repository.findActiveByOrder(input.tenantId, input.orderId);
      const blockingIsStalePending = blocking && blocking.status === 'pending' && blocking.expiresAt.getTime() <= input.now.getTime();
      if (!blockingIsStalePending) {
        return { kind: 'already_pending', approvalId: blocking?.id ?? '' };
      }

      await this.repository.expire(input.tenantId, blocking.id, input.now);
      try {
        return { kind: 'created', approval: await attempt() };
      } catch (retryErr) {
        if (!(retryErr instanceof DuplicateActiveApprovalError)) {
          throw retryErr;
        }
        // Lost the race to someone else proposing for this order right after we expired the
        // stale one - give up, report whatever is active now.
        const nowBlocking = await this.repository.findActiveByOrder(input.tenantId, input.orderId);
        return { kind: 'already_pending', approvalId: nowBlocking?.id ?? blocking.id };
      }
    }
  }

  /**
   * GET-path lazy expiry (amendment F2) - findById/list wrap this so a
   * stale pending row self-heals (its slot in the active-per-order index
   * releases) the moment anyone looks at it, not only when a decision is
   * actually attempted on it.
   */
  async getById(tenantId: string, id: string, now: Date): Promise<ApprovalRecord | null> {
    const record = await this.repository.findById(tenantId, id);
    return this.lazilyExpireIfNeeded(tenantId, record, now);
  }

  async list(tenantId: string, query: ApprovalListQuery, now: Date): Promise<ApprovalListResult> {
    const result = await this.repository.list(tenantId, query);
    const approvals = await Promise.all(result.approvals.map((a) => this.lazilyExpireIfNeeded(tenantId, a, now)));
    return { ...result, approvals: approvals.filter((a): a is ApprovalRecord => a !== null) };
  }

  private async lazilyExpireIfNeeded(tenantId: string, record: ApprovalRecord | null, now: Date): Promise<ApprovalRecord | null> {
    if (!record || record.status !== 'pending' || record.expiresAt.getTime() > now.getTime()) {
      return record;
    }
    const expired = await this.repository.expire(tenantId, record.id, now);
    return expired ?? record; // a lost race (someone else approved/rejected it first) just returns the current record as-is
  }

  /**
   * approve/reject. `fetchFreshOrderSnapshot`/`tenantSettings` are only
   * ever used on the FIRST decision attempt (amendment A) - every retry
   * path below skips straight to execution, never re-verifying.
   */
  async decide(
    tenantId: string,
    id: string,
    decision: 'approve' | 'reject',
    decidedBy: string,
    now: Date,
    tenantSettings: RefundVerifierTenantSettings,
    fetchFreshOrderSnapshot: FetchFreshOrderSnapshot,
    appendCustomerMessage?: AppendCustomerMessage,
  ): Promise<DecideResult> {
    // Deliberately the PLAIN repository read here, not this.getById() - decide() needs to tell
    // "was pending and past expiresAt" (-> EXPIRED, its own distinct decision-attempt outcome)
    // apart from "was already in some other terminal state" (-> ALREADY_DECIDED), and
    // approveFromPending below performs the actual expire() write itself. The lazy-expiry
    // self-healing (amendment F2) belongs to the admin-facing getById/list methods, not to this
    // internal lookup.
    const approval = await this.repository.findById(tenantId, id);
    if (!approval) {
      return { ok: false, code: 'NOT_FOUND' };
    }

    if (decision === 'reject') {
      return this.reject(tenantId, approval, decidedBy, now, appendCustomerMessage);
    }

    switch (approval.status) {
      case 'expired':
      case 'executed':
      case 'rejected':
        return { ok: false, code: 'ALREADY_DECIDED' };

      case 'pending':
        return this.approveFromPending(tenantId, approval, now, tenantSettings, fetchFreshOrderSnapshot, appendCustomerMessage);

      case 'executing': {
        const leaseExpired = now.getTime() - (approval.executingSince?.getTime() ?? 0) >= this.settings.executionLeaseMs;
        if (!leaseExpired) {
          return { ok: false, code: 'IN_PROGRESS' };
        }
        const taken = await this.repository.takeOverStuckExecution(tenantId, approval.id, approval.executingSince!, now);
        if (!taken) {
          return { ok: false, code: 'IN_PROGRESS' };
        }
        return this.executeApproval(taken, tenantId, approval.conversationId, now, appendCustomerMessage);
      }

      case 'failed': {
        if (!approval.retryable) {
          return { ok: false, code: approval.failureClass === 'NEEDS_RECONCILIATION' ? 'AMBIGUOUS_RETRY_REQUIRED' : 'ALREADY_DECIDED' };
        }
        const retried = await this.repository.retryFromFailed(tenantId, approval.id, now);
        if (!retried) {
          return { ok: false, code: 'IN_PROGRESS' };
        }
        return this.executeApproval(retried, tenantId, approval.conversationId, now, appendCustomerMessage);
      }
    }
  }

  private async approveFromPending(
    tenantId: string,
    approval: ApprovalRecord,
    now: Date,
    tenantSettings: RefundVerifierTenantSettings,
    fetchFreshOrderSnapshot: FetchFreshOrderSnapshot,
    appendCustomerMessage?: AppendCustomerMessage,
  ): Promise<DecideResult> {
    if (approval.expiresAt.getTime() <= now.getTime()) {
      await this.repository.expire(tenantId, approval.id, now);
      return { ok: false, code: 'EXPIRED' };
    }

    const freshOrder = await fetchFreshOrderSnapshot(tenantId, approval.orderId);
    if (!freshOrder) {
      // The order can no longer be read at all (deleted, connector down, etc.) - treated as a
      // structural ineligibility, never guessed as "fine, proceed anyway".
      return this.denyAtDecisionTime(tenantId, approval, now, ['ORDER_STATUS_INELIGIBLE'], [{ code: 'ORDER_STATUS_INELIGIBLE', passed: false }], appendCustomerMessage);
    }

    // Amendment A: the full verifier re-check runs exactly here - once, before the first
    // execution attempt, never again on any later retry.
    const recheck = verifyRefundProposal({
      proposedAmountCents: approval.amountCents,
      order: freshOrder,
      verifiedCustomerRef: approval.customerRef,
      citations: approval.citations,
      tenantSettings,
      customerDailyRefundCount: 0,
      clock: () => now,
    });

    if (recheck.decision === 'deny') {
      return this.denyAtDecisionTime(tenantId, approval, now, recheck.failedRuleCodes, recheck.verdicts, appendCustomerMessage);
    }

    const begun = await this.repository.beginExecution(tenantId, approval.id, recheck.verdicts, now);
    if (!begun) {
      return { ok: false, code: 'IN_PROGRESS' };
    }
    return this.executeApproval(begun, tenantId, approval.conversationId, now, appendCustomerMessage);
  }

  private async denyAtDecisionTime(
    tenantId: string,
    approval: ApprovalRecord,
    now: Date,
    failedRuleCodes: VerifierFailureCode[],
    verdicts: ApprovalRecord['verifierVerdictAtProposal'],
    appendCustomerMessage?: AppendCustomerMessage,
  ): Promise<DecideResult> {
    const failed = await this.repository.markFailed(
      tenantId,
      approval.id,
      approval.attemptCount,
      { retryable: false, active: false, reasonCode: failedRuleCodes[0], verifierVerdictAtDecision: verdicts },
      now,
    );
    if (!failed) {
      return { ok: false, code: 'IN_PROGRESS' };
    }
    await this.safeAppend(appendCustomerMessage, tenantId, approval.conversationId, buildTerminalDenialMessage(approval.orderId));
    return { ok: false, code: 'VERIFIER_DENIED', failedRuleCodes };
  }

  private async reject(
    tenantId: string,
    approval: ApprovalRecord,
    decidedBy: string,
    now: Date,
    appendCustomerMessage?: AppendCustomerMessage,
  ): Promise<DecideResult> {
    const rejected = await this.repository.reject(tenantId, approval.id, decidedBy, now);
    if (!rejected) {
      // Reject is blocked for BOTH ambiguous classes (amendment A's own AMBIGUOUS, and F4's
      // NEEDS_RECONCILIATION) - the repository's own query already enforces this; here we just
      // need the right diagnostic code for whichever one it was.
      if (approval.status === 'failed' && (approval.failureClass === 'AMBIGUOUS' || approval.failureClass === 'NEEDS_RECONCILIATION')) {
        return { ok: false, code: 'AMBIGUOUS_RETRY_REQUIRED' };
      }
      if (approval.status === 'executing') {
        return { ok: false, code: 'IN_PROGRESS' };
      }
      return { ok: false, code: 'ALREADY_DECIDED' };
    }
    const message = buildRejectedMessage(approval.orderId);
    await this.safeAppend(appendCustomerMessage, tenantId, approval.conversationId, message);
    return { ok: true, status: 'rejected', message };
  }

  /**
   * Calls the privileged runner and records the outcome. A `null` from
   * markExecuted/markFailed means this attempt was fenced out (amendment
   * F1) - the system is already in the correct state from a different
   * attempt's write, so this logs for visibility and returns that
   * reality, never retries or alarms on its own.
   */
  private async executeApproval(
    approval: ApprovalRecord,
    tenantId: string,
    conversationId: string,
    now: Date,
    appendCustomerMessage?: AppendCustomerMessage,
  ): Promise<DecideResult> {
    const result = await this.privilegedRefundRunner.execute(approval);

    if (result.ok) {
      const executed = await this.repository.markExecuted(tenantId, approval.id, approval.attemptCount, now);
      if (!executed) {
        this.logger.warn(
          JSON.stringify({ event: 'approval_execution_unreconciled', tenantId, approvalId: approval.id, reason: 'stale_success_fenced_out' }),
        );
        const current = await this.repository.findById(tenantId, approval.id);
        if (current?.status === 'executed') {
          return { ok: true, status: 'executed', message: buildApprovedAndExecutedMessage(approval.orderId, amountDollars(approval.amountCents)) };
        }
        return { ok: false, code: 'IN_PROGRESS' };
      }
      const message = buildApprovedAndExecutedMessage(approval.orderId, amountDollars(approval.amountCents));
      await this.safeAppend(appendCustomerMessage, tenantId, conversationId, message);
      return { ok: true, status: 'executed', message };
    }

    const classification = classifyRefundExecutionFailure(result.error.code as ToolRunErrorCode, approval.attemptCount > 1);
    const failed = await this.repository.markFailed(
      tenantId,
      approval.id,
      approval.attemptCount,
      {
        retryable: classification.retryable,
        active: classification.staysActive,
        executionResultCode: result.error.code,
        upstreamMaybeReceived: classification.upstreamMaybeReceived,
        failureClass: classification.failureClass,
      },
      now,
    );
    if (!failed) {
      return { ok: false, code: 'IN_PROGRESS' };
    }
    // AMBIGUOUS and NEEDS_RECONCILIATION are never surfaced to the customer as a plain failure
    // (F4) - only a genuinely terminal, definitive denial gets the fixed message.
    if (classification.failureClass === 'DEFINITIVE') {
      await this.safeAppend(appendCustomerMessage, tenantId, conversationId, buildTerminalDenialMessage(approval.orderId));
    }
    return { ok: true, status: 'failed', retryable: classification.retryable };
  }

  private async safeAppend(
    appendCustomerMessage: AppendCustomerMessage | undefined,
    tenantId: string,
    conversationId: string,
    message: string,
  ): Promise<void> {
    if (!appendCustomerMessage) {
      return;
    }
    try {
      await appendCustomerMessage(tenantId, conversationId, message);
    } catch (err) {
      this.logger.error(
        JSON.stringify({ event: 'approval_followup_append_failed', tenantId, conversationId, error: err instanceof Error ? err.message : 'unknown' }),
      );
    }
  }
}
