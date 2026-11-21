import { Module } from '@nestjs/common';
import { ConnectorsModule } from '../connectors/connectors.module';
import { ToolRunnerModule } from '../agent/tool-runner/tool-runner.module';
import { DatabaseModule } from '../db/database.module';
import { AdminAuthModule } from '../admin-auth/admin-auth.module';
import { APPROVAL_PROPOSAL_PORT } from './approval-proposal.port';
import { approvalDecisionRateLimiterProvider } from './approval-decision-rate-limiter.provider';
import { approvalsReadOnlyToolRunnerProvider } from './approvals-read-only-tool-runner.provider';
import { ApprovalsController } from './approvals.controller';
import { ApprovalService } from './approval.service';
import { approvalServiceSettingsProvider } from './approval-service-settings.provider';
import { PrivilegedRefundRunner } from './privileged-refund-runner';

/**
 * Same pattern as chat.module.ts's own `chatDatabaseImportsFor` / ingestion.module.ts's
 * `ingestionDatabaseImportsFor` - DatabaseModule crashes immediately if imported with no
 * MONGODB_URI set (MongooseModule.forRoot with no URI), so this module must stay importable
 * (and therefore independently testable, e.g. in this module's own architecture test) with no
 * database at all, exactly like every other domain module in this codebase.
 */
export function approvalsDatabaseImportsFor(env: NodeJS.ProcessEnv): [typeof DatabaseModule] | [] {
  return env.MONGODB_URI ? [DatabaseModule] : [];
}

/**
 * `PrivilegedRefundRunner` is a plain provider here, deliberately absent
 * from `exports` - it is reachable only through `ApprovalService`, never
 * directly, by anything outside this module (PROJECT.md's Milestone 4
 * design: "never exported from ApprovalsModule"). Proven by
 * `test/architecture/privileged-runner-not-injectable.spec.ts`.
 *
 * Amendment G3: `ApprovalService` itself is ALSO absent from `exports`, for
 * the same reason, one level up. `ApprovalService` has `decide`/`getById`/`list` -
 * the admin-decision surface - alongside `createFromProposal`; a consumer outside
 * this module (chat.service.ts, Stage 5) has no business calling the former, so it
 * is given no way to even type against the whole class. Only `APPROVAL_PROPOSAL_PORT`
 * (`ApprovalProposalPort`'s narrow, single-method shape) is exported, bound via
 * `useExisting` to the same singleton `ApprovalService` instance - there is still
 * exactly one object at runtime, just two different-width views of it depending on
 * which side of the module boundary you're standing on.
 *
 * Imported by ChatModule (Stage 5) for exactly that one port token - see
 * chat.module.ts's own doc comment.
 *
 * Stage 6 - `ApprovalsController` (GET /v1/approvals, GET /v1/approvals/:id,
 * POST /v1/approvals/:id/decision) lives in THIS module's own `controllers`,
 * not some other module importing ApprovalService from outside - amendment
 * G3 above is exactly why: the admin surface needs the full service, which
 * is never exported. `ConnectorsModule` is imported directly (not only via
 * `ToolRunnerModule`, which imports it too but does not re-export
 * `CONNECTOR_CONFIG_REPOSITORY` in its own `exports` - confirmed by reading
 * tool-runner.module.ts) because `approvalsReadOnlyToolRunnerProvider`
 * needs that token for its own `ReadOnlyToolRunner` construction, the same
 * dependency chat.module.ts separately satisfies for its own sibling
 * provider.
 */
@Module({
  imports: [ToolRunnerModule, ConnectorsModule, AdminAuthModule, ...approvalsDatabaseImportsFor(process.env)],
  controllers: [ApprovalsController],
  providers: [
    ApprovalService,
    PrivilegedRefundRunner,
    approvalServiceSettingsProvider,
    approvalDecisionRateLimiterProvider,
    approvalsReadOnlyToolRunnerProvider,
    { provide: APPROVAL_PROPOSAL_PORT, useExisting: ApprovalService },
  ],
  exports: [APPROVAL_PROPOSAL_PORT],
})
export class ApprovalsModule {}
