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
  /** Stage 5 follow-up I1(b) - the same runId chat.service.ts already generates per request. See agent-run.schema.ts's own doc comment on the field and its unique index. */
  runId: string;
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

/** Stage 5 follow-up I1(b) - thrown instead of a plain duplicate-key passthrough when `create()`'s insert collides with the `{tenantId, runId}` unique index, so a caller can distinguish "this exact run already has an AgentRun" from any other create() failure without inspecting a raw Mongo error code. */
export class DuplicateAgentRunError extends Error {
  constructor(public readonly runId: string) {
    super(`An AgentRun already exists for runId "${runId}".`);
  }
}

export interface AgentRunRepository {
  /**
   * `session` (Stage 5) - a Mongoose ClientSession, so this write can participate in the same
   * transaction as an Approval row's own insert; omitted, a plain standalone insert. Typed
   * `unknown`, same convention `ApprovalRepository.create`'s own `session?: unknown` already
   * uses. Throws `DuplicateAgentRunError` (never a raw Mongo E11000) when `run.runId` already
   * has an AgentRun - the caller (ApprovalService) is what decides whether that means "read the
   * existing one back, this is an idempotent retry" or something else.
   */
  create(run: NewAgentRun, session?: unknown): Promise<AgentRunRecord>;
  /** Milestone 5's admin console reasoning panel, and Milestone 6's eval harness - both need a run's full trace, never filtered by step type. */
  findByConversation(tenantId: string, conversationId: string): Promise<AgentRunRecord[]>;
  /** Stage 5 follow-up I1(b) - the read-back half of create()'s idempotency contract. Null if no AgentRun exists yet for this runId. */
  findByRunId(tenantId: string, runId: string): Promise<AgentRunRecord | null>;
  /** Test/ops cleanup only. */
  deleteForTenant(tenantId: string): Promise<void>;
}

export const AGENT_RUN_REPOSITORY = Symbol('AGENT_RUN_REPOSITORY');

function toRecord(doc: AgentRunDocument): AgentRunRecord {
  return {
    id: doc._id.toString(),
    tenantId: doc.tenantId,
    runId: doc.runId,
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

function isDuplicateKeyError(err: unknown): boolean {
  return typeof err === 'object' && err !== null && 'code' in err && (err as { code: unknown }).code === 11000;
}

@Injectable()
export class MongooseAgentRunRepository implements AgentRunRepository {
  constructor(@InjectModel('AgentRun') private readonly model: Model<AgentRunDocument>) {}

  async create(run: NewAgentRun, session?: unknown): Promise<AgentRunRecord> {
    try {
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
    } catch (err) {
      if (isDuplicateKeyError(err)) {
        throw new DuplicateAgentRunError(run.runId);
      }
      throw err;
    }
  }

  async findByConversation(tenantId: string, conversationId: string): Promise<AgentRunRecord[]> {
    const docs = await this.model.find({ tenantId, conversationId }).sort({ createdAt: 1 }).lean();
    return docs.map((doc) => toRecord(doc as unknown as AgentRunDocument));
  }

  async findByRunId(tenantId: string, runId: string): Promise<AgentRunRecord | null> {
    const doc = await this.model.findOne({ tenantId, runId }).lean();
    return doc ? toRecord(doc as unknown as AgentRunDocument) : null;
  }

  async deleteForTenant(tenantId: string): Promise<void> {
    await this.model.deleteMany({ tenantId });
  }
}
