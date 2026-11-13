import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { DegradedReason } from '@supportpilot/shared';
import { Model } from 'mongoose';
import { AgentProposedActionSubdocument, AgentRunDocument, AgentStepSubdocument, RefundDispositionSubdocument } from './schemas/agent-run.schema';

export type NewAgentRunStep = AgentStepSubdocument;
export type NewAgentRunProposedAction = AgentProposedActionSubdocument;
export type NewAgentRunRefundDisposition = RefundDispositionSubdocument;

export interface NewAgentRun {
  tenantId: string;
  conversationId: string;
  outcome: 'reply' | 'clarify' | 'escalate' | 'pending_approval';
  degraded?: DegradedReason;
  stepCount: number;
  llmCallCount: number;
  tokensIn: number;
  tokensOut: number;
  latencyMs: number;
  steps: NewAgentRunStep[];
  proposedAction?: NewAgentRunProposedAction;
  /** Milestone 4 amendment D - written once here, never updated afterward. Absent entirely for a run that never proposed a refund at all. */
  refundDisposition?: NewAgentRunRefundDisposition;
}

export interface AgentRunRecord extends Omit<NewAgentRun, 'degraded' | 'proposedAction' | 'refundDisposition'> {
  id: string;
  degraded: DegradedReason | null;
  proposedAction: NewAgentRunProposedAction | null;
  refundDisposition: NewAgentRunRefundDisposition | null;
  createdAt: Date;
}

export interface AgentRunRepository {
  /** `session` (Stage 5) - a Mongoose ClientSession, so this write can participate in the same transaction as an Approval row's own insert; omitted, a plain standalone insert. Typed `unknown`, same convention `ApprovalRepository.create`'s own `session?: unknown` already uses. */
  create(run: NewAgentRun, session?: unknown): Promise<AgentRunRecord>;
  /** Milestone 5's admin console reasoning panel, and Milestone 6's eval harness - both need a run's full trace, never filtered by step type. */
  findByConversation(tenantId: string, conversationId: string): Promise<AgentRunRecord[]>;
  /** Test/ops cleanup only. */
  deleteForTenant(tenantId: string): Promise<void>;
}

export const AGENT_RUN_REPOSITORY = Symbol('AGENT_RUN_REPOSITORY');

function toRecord(doc: AgentRunDocument): AgentRunRecord {
  return {
    id: doc._id.toString(),
    tenantId: doc.tenantId,
    conversationId: doc.conversationId,
    outcome: doc.outcome,
    degraded: doc.degraded,
    stepCount: doc.stepCount,
    llmCallCount: doc.llmCallCount,
    tokensIn: doc.tokensIn,
    tokensOut: doc.tokensOut,
    latencyMs: doc.latencyMs,
    steps: doc.steps,
    proposedAction: doc.proposedAction,
    refundDisposition: doc.refundDisposition,
    createdAt: doc.createdAt,
  };
}

@Injectable()
export class MongooseAgentRunRepository implements AgentRunRepository {
  constructor(@InjectModel('AgentRun') private readonly model: Model<AgentRunDocument>) {}

  async create(run: NewAgentRun, session?: unknown): Promise<AgentRunRecord> {
    const [doc] = await this.model.create(
      [
        {
          ...run,
          degraded: run.degraded ?? null,
          proposedAction: run.proposedAction ?? null,
          refundDisposition: run.refundDisposition ?? null,
        },
      ],
      { session: session as never },
    );
    return toRecord(doc);
  }

  async findByConversation(tenantId: string, conversationId: string): Promise<AgentRunRecord[]> {
    const docs = await this.model.find({ tenantId, conversationId }).sort({ createdAt: 1 }).lean();
    return docs.map((doc) => toRecord(doc as unknown as AgentRunDocument));
  }

  async deleteForTenant(tenantId: string): Promise<void> {
    await this.model.deleteMany({ tenantId });
  }
}
