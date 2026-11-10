import { Injectable } from '@nestjs/common';
import { fromCents } from '@supportpilot/shared';
import { ToolRunnerService } from '../agent/tool-runner/tool-runner.service';
import { ToolRunResult } from '../agent/tool-runner/tool-runner';
import { ApprovalRecord } from './approval.repository';

/**
 * The ONLY code in this entire project allowed to call `issue_refund`
 * (PROJECT.md's Milestone 4 design, the permanent rule replacing RULES.md
 * §5's retired Milestone 1 exception). Never exported from
 * ApprovalsModule (see approvals.module.ts) - a plain internal provider,
 * reachable only through ApprovalService.
 *
 * Takes an Approval record the caller has ALREADY atomically moved to
 * `executing` (asserted below, defense-in-depth - the real guarantee is
 * structural: nothing calls this except ApprovalService, right after
 * winning that atomic transition). Builds the upstream request ONLY from
 * the record's own already-verified, already-stored fields - never
 * re-reads anything live, never accepts a tool name parameter (hard-coded
 * to exactly 'issue_refund'), so there is no argument shape through which
 * this could ever be made to call a different tool or send different data
 * than what the Approval itself already records.
 */
@Injectable()
export class PrivilegedRefundRunner {
  constructor(private readonly toolRunnerService: ToolRunnerService) {}

  async execute(approval: ApprovalRecord): Promise<ToolRunResult> {
    if (approval.status !== 'executing') {
      throw new Error(`PrivilegedRefundRunner.execute called with Approval ${approval.id} in status "${approval.status}", expected "executing".`);
    }

    return this.toolRunnerService.run(approval.tenantId, 'issue_refund', {
      order_id: approval.orderId,
      amount: fromCents(approval.amountCents),
      idempotencyKey: approval.idempotencyKey,
    });
  }
}
