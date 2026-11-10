import { Module } from '@nestjs/common';
import { ToolRunnerModule } from '../agent/tool-runner/tool-runner.module';
import { DatabaseModule } from '../db/database.module';
import { ApprovalService } from './approval.service';
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
 * Not yet imported by AppModule (no chat wiring in this stage) - this
 * module is self-contained and independently testable until that stage
 * wires `ApprovalService` into `chat.service.ts`.
 */
@Module({
  imports: [ToolRunnerModule, ...approvalsDatabaseImportsFor(process.env)],
  providers: [ApprovalService, PrivilegedRefundRunner],
  exports: [ApprovalService],
})
export class ApprovalsModule {}
