import { Module } from '@nestjs/common';
import { ToolRunnerModule } from '../agent/tool-runner/tool-runner.module';
import { DatabaseModule } from '../db/database.module';
import { APPROVAL_PROPOSAL_PORT } from './approval-proposal.port';
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
 */
@Module({
  imports: [ToolRunnerModule, ...approvalsDatabaseImportsFor(process.env)],
  providers: [
    ApprovalService,
    PrivilegedRefundRunner,
    approvalServiceSettingsProvider,
    { provide: APPROVAL_PROPOSAL_PORT, useExisting: ApprovalService },
  ],
  exports: [APPROVAL_PROPOSAL_PORT],
})
export class ApprovalsModule {}
