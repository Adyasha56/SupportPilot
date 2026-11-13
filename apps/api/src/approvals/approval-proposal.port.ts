import { VerifierFailureCode } from '@supportpilot/shared';
import { AppendCustomerMessage, CreateFromProposalInput, CreateFromProposalResult } from './approval.service';

/**
 * Re-exported so chat.service.ts (Stage 5) never needs an import from `./approval.service` at
 * all - this port file is its one and only window into the approvals module's internals.
 */
export type { AppendCustomerMessage, CreateFromProposalInput, CreateFromProposalResult };

/**
 * Milestone 4 Stage 5 - the disposition chat.service.ts's own AgentRun write must record
 * (AgentRunRepository's NewAgentRunRefundDisposition, mirrored here rather than imported so this
 * port stays decoupled from db/schemas - the two shapes are kept honest by chat.service.ts's own
 * direct conversion at the one call site that uses both).
 */
export interface RefundDispositionForAgentRun {
  kind: 'denied' | 'pending_approval' | 'auto_executed' | 'already_pending';
  /** Only present for kind: 'denied'. */
  failedRuleCodes?: VerifierFailureCode[];
  /** Present for every kind except 'denied'. */
  approvalId?: string;
}

/**
 * Stage 5's transactional dual-write hook (see approval.service.ts's own doc comment on
 * `createApprovalRow` for why ApprovalService, not chat.service.ts, has to be the one calling
 * this): writes the AgentRun with the given refund disposition, participating in the SAME Mongo
 * session as the Approval row's own insert when one is given - `session: undefined` means a
 * plain standalone write (the 'denied'/'already_pending' paths, where no Approval row is created
 * alongside it, so there's nothing else to keep atomic with). `session` is typed `unknown`, the
 * same convention `ApprovalRepository.create`'s own `session?: unknown` already uses, so this
 * port never needs to import a concrete Mongoose type either.
 */
export type PersistAgentRunForProposal = (disposition: RefundDispositionForAgentRun, session?: unknown) => Promise<void>;

/**
 * Amendment G3 - the ONLY thing chat.service.ts (Stage 5) is allowed to depend on from the
 * approvals module. `ApprovalService` also exposes `decide`, `getById`, and `list` - the
 * admin-decision surface - which the chat path has no business calling; narrowing the
 * dependency to this single method keeps that structurally true rather than just conventionally
 * true. `ApprovalsModule` exports only `APPROVAL_PROPOSAL_PORT` (this token), never
 * `ApprovalService` itself - see approvals.module.ts's own doc comment.
 */
export interface ApprovalProposalPort {
  createFromProposal(
    input: CreateFromProposalInput,
    persistAgentRun: PersistAgentRunForProposal,
    appendCustomerMessage?: AppendCustomerMessage,
  ): Promise<CreateFromProposalResult>;
}

export const APPROVAL_PROPOSAL_PORT = Symbol('APPROVAL_PROPOSAL_PORT');
