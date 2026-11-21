import { Body, Controller, Get, HttpCode, Inject, Logger, NotFoundException, Optional, Param, Post, Query, UseFilters, UseGuards } from '@nestjs/common';
import {
  ApprovalDecisionRequestSchema,
  ApprovalListQuerySchema,
  ApprovalListResponse,
  ApprovalRecord as ApprovalRecordDTO,
  decidedByForAdminSession,
  decidedByForApiKey,
} from '@supportpilot/shared';
import { RateLimiter } from '../auth/rate-limiter';
import { AdminAuthGuard, AdminPrincipal } from '../admin-auth/admin-auth.guard';
import { CurrentAdminPrincipal } from '../admin-auth/current-admin-principal.decorator';
import { ChatRetryAfterFilter } from '../chat/chat-retry-after.filter';
import { ConversationRepository, CONVERSATION_REPOSITORY } from '../db/conversation.repository';
import { MessageRepository, MESSAGE_REPOSITORY } from '../db/message.repository';
import { TenantRepository, TENANT_REPOSITORY } from '../db/tenant.repository';
import { approvalHttpError } from './approval-http-error';
import { ApprovalRecord, ApprovalRepository, APPROVAL_REPOSITORY } from './approval.repository';
import { ApprovalService, DecideResult } from './approval.service';
import { APPROVAL_DECISION_RATE_LIMITER } from './approval-decision-rate-limiter.provider';
import { APPROVALS_READ_ONLY_TOOL_RUNNER } from './approvals-read-only-tool-runner.provider';
import { fetchFreshOrderSnapshotViaReadOnlyToolRunner, ReadOnlyGetOrderRunner } from './fetch-fresh-order-snapshot';

function toRecordDTO(record: ApprovalRecord): ApprovalRecordDTO {
  return {
    id: record.id,
    tenantId: record.tenantId,
    runId: record.runId,
    conversationId: record.conversationId,
    orderId: record.orderId,
    customerRef: record.customerRef,
    amount: Math.round(record.amountCents) / 100,
    citations: record.citations,
    status: record.status,
    ...(record.reasonCode ? { reasonCode: record.reasonCode } : {}),
    ...(record.adminReasonCode ? { adminReasonCode: record.adminReasonCode } : {}),
    ...(record.executionResultCode ? { executionResultCode: record.executionResultCode } : {}),
    ...(record.failureClass ? { failureClass: record.failureClass } : {}),
    ...(record.upstreamMaybeReceived !== null ? { upstreamMaybeReceived: record.upstreamMaybeReceived } : {}),
    ...(record.decidedBy ? { decidedBy: record.decidedBy } : {}),
    ...(record.decidedAt ? { decidedAt: record.decidedAt.toISOString() } : {}),
    expiresAt: record.expiresAt.toISOString(),
    createdAt: record.createdAt.toISOString(),
  };
}

function msToSeconds(ms: number): number {
  return Math.ceil(ms / 1000);
}

/**
 * Milestone 4 Stage 6 - the admin decision surface. Milestone 5, Stage 1b
 * moved this from `@UseGuards(ApiKeyGuard) @RequireScope('admin')` to
 * `AdminAuthGuard` (item 6) - a secret-scope API key still gets the exact
 * same generic rejection a public key does (AdminAuthGuard's own
 * header-present-means-ONLY-the-admin-scoped-key-path rule), and a
 * cookie-authenticated admin console session now works here too, with no
 * separate code path - `tenantId` comes from the resolved `AdminPrincipal`
 * (never `@CurrentTenant()`, which only ever reads what `ApiKeyGuard`
 * itself sets - this controller no longer uses that guard at all).
 *
 * Deliberately lives INSIDE ApprovalsModule (not some other module importing ApprovalService
 * from outside) - the admin surface genuinely needs the WHOLE service (decide/getById/list),
 * which amendment G3 specifically keeps unreachable from everywhere else (chat.service.ts only
 * ever sees the narrow ApprovalProposalPort). This controller is the one place in the app that
 * is allowed to depend on the full ApprovalService.
 */
@Controller('v1/approvals')
@UseGuards(AdminAuthGuard)
@UseFilters(ChatRetryAfterFilter)
export class ApprovalsController {
  private readonly logger = new Logger(ApprovalsController.name);
  private readonly clock: () => Date;

  constructor(
    private readonly approvalService: ApprovalService,
    @Optional() @Inject(APPROVAL_REPOSITORY) private readonly approvalRepository: ApprovalRepository | undefined,
    @Optional() @Inject(TENANT_REPOSITORY) private readonly tenantRepository: TenantRepository | undefined,
    @Optional() @Inject(MESSAGE_REPOSITORY) private readonly messageRepository: MessageRepository | undefined,
    @Optional() @Inject(CONVERSATION_REPOSITORY) private readonly conversationRepository: ConversationRepository | undefined,
    @Inject(APPROVALS_READ_ONLY_TOOL_RUNNER) private readonly toolRunner: ReadOnlyGetOrderRunner,
    @Inject(APPROVAL_DECISION_RATE_LIMITER) private readonly rateLimiter: RateLimiter,
    @Optional() clock?: () => Date,
  ) {
    this.clock = clock ?? (() => new Date());
  }

  @Get()
  async list(@CurrentAdminPrincipal() principal: AdminPrincipal, @Query() rawQuery: unknown): Promise<ApprovalListResponse> {
    this.assertConfigured();
    const parsed = ApprovalListQuerySchema.safeParse(rawQuery);
    if (!parsed.success) {
      throw approvalHttpError('INVALID_REQUEST', 'The query parameters are invalid.');
    }
    const result = await this.approvalService.list(principal.tenantId, parsed.data, this.clock());
    return { approvals: result.approvals.map(toRecordDTO), ...(result.nextCursor ? { nextCursor: result.nextCursor } : {}) };
  }

  @Get(':id')
  async getOne(@CurrentAdminPrincipal() principal: AdminPrincipal, @Param('id') id: string): Promise<ApprovalRecordDTO> {
    this.assertConfigured();
    const record = await this.approvalService.getById(principal.tenantId, id, this.clock());
    if (!record) {
      // Identical 404 whether the id belongs to another tenant or doesn't exist at all - same
      // principle as PoliciesController's own remove() and the auth guard's uniform 401.
      throw new NotFoundException();
    }
    return toRecordDTO(record);
  }

  @Post(':id/decision')
  @HttpCode(200)
  async decide(@CurrentAdminPrincipal() principal: AdminPrincipal, @Param('id') id: string, @Body() rawBody: unknown): Promise<ApprovalRecordDTO> {
    this.assertConfigured();
    const tenantId = principal.tenantId;
    // Milestone 5, Stage 1b, item 6 - the decidedBy format: which KIND of principal decided,
    // never a bare id alone. The rate limiter is keyed the same way - a session principal and
    // an admin API key never share a decision-attempt budget just because both might
    // (coincidentally) carry the same principalId value (they never do in practice, since
    // principalId means different things per kind, but keying by the full decidedBy string
    // keeps that true structurally, not by coincidence).
    const decidedBy = principal.kind === 'api_key' ? decidedByForApiKey(principal.principalId) : decidedByForAdminSession(principal.principalId);
    const rateDecision = this.rateLimiter.tryConsume(decidedBy);
    if (!rateDecision.allowed) {
      throw approvalHttpError('RATE_LIMITED', 'Too many decision attempts. Please try again shortly.', msToSeconds(rateDecision.retryAfterMs));
    }

    const parsed = ApprovalDecisionRequestSchema.safeParse(rawBody);
    if (!parsed.success) {
      throw approvalHttpError('INVALID_REQUEST', 'The request body is invalid.');
    }
    const { decision, reasonCode } = parsed.data;

    // Deliberately the PLAIN repository read here, never approvalService.getById() - that method
    // performs lazy expiry as a side effect (amendment F2, for the admin GET routes), which would
    // silently flip a pending-but-past-expiry row to 'expired' BEFORE decide() ever runs,
    // masking the real "decide on an expired row" outcome (EXPIRED, written by decide() itself)
    // behind a stale-seeming ALREADY_DECIDED instead. findById() has no side effects, so this
    // pre-check can never change what decide() is about to see.
    const before = this.approvalRepository ? await this.approvalRepository.findById(tenantId, id) : null;
    if (!before) {
      throw new NotFoundException();
    }

    const tenant = this.tenantRepository ? await this.tenantRepository.findById(tenantId) : null;
    const tenantSettings = {
      refundCap: tenant?.refundCap ?? 0,
      approvalThreshold: tenant?.approvalThreshold ?? 0,
      refundWindowDays: tenant?.refundWindowDays ?? 0,
      autoExecuteRefunds: tenant?.autoExecuteRefunds ?? false,
      ...(tenant?.dailyRefundCountLimit !== undefined ? { dailyRefundCountLimit: tenant.dailyRefundCountLimit } : {}),
    };

    const fetchFreshOrderSnapshot = (tid: string, orderId: string) => fetchFreshOrderSnapshotViaReadOnlyToolRunner(this.toolRunner, tid, orderId);
    const appendCustomerMessage = async (tid: string, conversationId: string, message: string): Promise<void> => {
      if (!this.messageRepository || !this.conversationRepository) {
        return;
      }
      await this.messageRepository.create(tid, conversationId, 'agent', message);
      await this.conversationRepository.incrementMessageCount(tid, conversationId, 1);
    };

    const result = await this.approvalService.decide(
      tenantId,
      id,
      decision,
      decidedBy,
      this.clock(),
      tenantSettings,
      fetchFreshOrderSnapshot,
      reasonCode,
      appendCustomerMessage,
    );

    this.audit(tenantId, id, decidedBy, before.status, result);

    if (!result.ok) {
      if (result.code === 'NOT_FOUND') {
        throw new NotFoundException();
      }
      if (result.code === 'VERIFIER_DENIED') {
        // The decision WAS successfully processed - it just resulted in a denial (the row moved
        // to failed, non-retryable). A real, successful 200, not an error - never conflated with
        // "the decision attempt itself couldn't even be processed" (the codes below).
        const after = await this.approvalService.getById(tenantId, id, this.clock());
        return toRecordDTO(after!);
      }
      throw approvalHttpError(result.code, this.messageForErrorCode(result.code));
    }

    const after = await this.approvalService.getById(tenantId, id, this.clock());
    return toRecordDTO(after!);
  }

  private messageForErrorCode(code: Exclude<DecideResult, { ok: true }>['code']): string {
    switch (code) {
      case 'EXPIRED':
        return 'This approval has expired and can no longer be decided.';
      case 'IN_PROGRESS':
        return 'This approval is currently being executed. Try again shortly.';
      case 'AMBIGUOUS_RETRY_REQUIRED':
        return 'A prior execution attempt was ambiguous - retry the approval instead of rejecting it.';
      case 'ALREADY_DECIDED':
        return 'This approval has already reached a final decision.';
      case 'ORDER_FETCH_FAILED':
        return 'Could not fetch current order details. No decision was recorded - try again shortly.';
      default:
        return 'Unable to process this decision.';
    }
  }

  /** ids and codes only - never customer text, never the reasonCode's own meaning beyond its code. `decidedBy` is the formatted `key:<id>`/`admin:<id>` string (decided-by.ts), never a bare id - which kind of principal decided is itself worth auditing. */
  private audit(tenantId: string, approvalId: string, decidedBy: string, fromStatus: string, result: DecideResult): void {
    const toStatus = result.ok ? result.status : (this.lastKnownStatusForError(result.code) ?? fromStatus);
    this.logger.log(
      JSON.stringify({
        event: 'approval_decision',
        tenantId,
        approvalId,
        decidedBy,
        fromStatus,
        toStatus,
        outcomeCode: result.ok ? result.status : result.code,
      }),
    );
  }

  private lastKnownStatusForError(code: string): string | undefined {
    if (code === 'VERIFIER_DENIED') return 'failed';
    if (code === 'EXPIRED') return 'expired';
    return undefined;
  }

  /**
   * `ApprovalService.getById`/`list`/`decide` all call straight through to `this.repository`
   * with no undefined-check of their own (same "safe to import, fails at the call site"
   * discipline the service's own doc comment describes) - calling them with no database
   * configured would throw a raw TypeError, not this project's own {statusCode, code, message}
   * shape. `tenantRepository` is undefined in EXACTLY that same case (DatabaseModule is only
   * ever conditionally imported on MONGODB_URI, by both database.module.ts and
   * approvals.module.ts's own approvalsDatabaseImportsFor), so it doubles as the signal here -
   * the same pattern chat.controller.ts's own sibling route leaves to its service layer, just
   * surfaced at the controller since ApprovalService's repository field isn't inspectable from
   * outside the class.
   */
  private assertConfigured(): void {
    if (!this.tenantRepository) {
      throw approvalHttpError('NOT_CONFIGURED', 'The database is not configured.');
    }
  }
}
