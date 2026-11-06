import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { AgentProposedActionSubdocument, AgentRunDocument, AgentStepSubdocument } from './schemas/agent-run.schema';

export type NewAgentRunStep = AgentStepSubdocument;
export type NewAgentRunProposedAction = AgentProposedActionSubdocument;

export interface NewAgentRun {
  tenantId: string;
  conversationId: string;
  outcome: 'reply' | 'clarify' | 'escalate' | 'pending_approval';
  degraded?: 'DAILY_BUDGET_EXCEEDED' | 'TENANT_BUDGET_EXCEEDED' | 'CIRCUIT_OPEN';
  stepCount: number;
  llmCallCount: number;
  tokensIn: number;
  tokensOut: number;
  latencyMs: number;
  steps: NewAgentRunStep[];
  proposedAction?: NewAgentRunProposedAction;
}

export interface AgentRunRecord extends Omit<NewAgentRun, 'degraded' | 'proposedAction'> {
  id: string;
  degraded: 'DAILY_BUDGET_EXCEEDED' | 'TENANT_BUDGET_EXCEEDED' | 'CIRCUIT_OPEN' | null;
  proposedAction: NewAgentRunProposedAction | null;
  createdAt: Date;
}

export interface AgentRunRepository {
  create(run: NewAgentRun): Promise<AgentRunRecord>;
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
    createdAt: doc.createdAt,
  };
}

@Injectable()
export class MongooseAgentRunRepository implements AgentRunRepository {
  constructor(@InjectModel('AgentRun') private readonly model: Model<AgentRunDocument>) {}

  async create(run: NewAgentRun): Promise<AgentRunRecord> {
    const doc = await this.model.create({ ...run, degraded: run.degraded ?? null, proposedAction: run.proposedAction ?? null });
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
