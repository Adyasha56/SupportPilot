import { Inject, Injectable, Optional } from '@nestjs/common';
import {
  AdminAgentRun,
  AdminAgentStep,
  AdminCitation,
  ConversationDetailResponse,
  ConversationListQuery as SharedConversationListQuery,
  ConversationListResponse,
  ConversationSummary,
} from '@supportpilot/shared';
import { AGENT_RUN_REPOSITORY, AgentRunRecord, AgentRunRepository } from '../db/agent-run.repository';
import { ConversationListQuery, ConversationRecord, ConversationRepository, CONVERSATION_REPOSITORY } from '../db/conversation.repository';
import { MESSAGE_REPOSITORY, MessageRepository } from '../db/message.repository';
import { ChunkLookupResult, POLICY_CHUNK_REPOSITORY, PolicyChunkRepository } from '../db/policy-chunk.repository';
import { parseChunkKey } from '../retrieval/chunk-key';

/**
 * Stage 1c, item 2 - the admin console's conversation-detail view keeps at
 * most this many of a conversation's most recent messages (never the
 * agent's own history window, which is a separate, much smaller setting -
 * see MessageRepository.findAllForConversation's own doc comment). Not a
 * configurable setting: an admin inspection view doesn't need the same
 * free-tier-budget tuning chat.settings.ts's history window does.
 */
export const ADMIN_CONVERSATION_DETAIL_MAX_MESSAGES = 500;

function toSummary(record: ConversationRecord): ConversationSummary {
  return {
    id: record.id,
    customerRef: record.customerRef,
    status: record.status,
    messageCount: record.messageCount,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  };
}

/** Every distinct chunkKey cited anywhere across a conversation's runs - deduplicated once, resolved in one batch call, never one lookup per step. */
function collectCitedChunkKeys(runs: AgentRunRecord[]): string[] {
  const keys = new Set<string>();
  for (const run of runs) {
    for (const step of run.steps) {
      for (const key of step.citedChunkKeys ?? []) {
        keys.add(key);
      }
    }
  }
  return [...keys];
}

/** Best-effort chunkKey -> {headingPath, documentTitle} map, built from whichever chunks still exist. A key that doesn't resolve (parse failure, or the chunk/document has since been deleted) is simply absent - callers fall back to the bare key. */
async function resolveCitationMap(
  tenantId: string,
  chunkKeys: string[],
  policyChunkRepository: PolicyChunkRepository | undefined,
): Promise<Map<string, ChunkLookupResult>> {
  const map = new Map<string, ChunkLookupResult>();
  if (!policyChunkRepository || chunkKeys.length === 0) {
    return map;
  }
  const parsed = chunkKeys.map((key) => ({ key, parsed: parseChunkKey(key) })).filter((entry) => entry.parsed !== undefined);
  if (parsed.length === 0) {
    return map;
  }
  const results = await policyChunkRepository.findManyByDocumentIdAndPosition(
    tenantId,
    parsed.map((entry) => entry.parsed!),
  );
  const byDocPosition = new Map(results.map((r) => [`${r.documentId}:${r.position}`, r]));
  for (const entry of parsed) {
    const result = byDocPosition.get(`${entry.parsed!.documentId}:${entry.parsed!.position}`);
    if (result) {
      map.set(entry.key, result);
    }
  }
  return map;
}

function toAdminCitations(citedChunkKeys: string[] | undefined, citationMap: Map<string, ChunkLookupResult>): AdminCitation[] | undefined {
  if (!citedChunkKeys || citedChunkKeys.length === 0) {
    return undefined;
  }
  return citedChunkKeys.map((chunkKey) => {
    const resolved = citationMap.get(chunkKey);
    return resolved ? { chunkKey, headingPath: resolved.headingPath, documentTitle: resolved.title } : { chunkKey };
  });
}

function toAdminAgentRun(run: AgentRunRecord, citationMap: Map<string, ChunkLookupResult>): AdminAgentRun {
  const steps: AdminAgentStep[] = run.steps.map((step) => {
    const citations = toAdminCitations(step.citedChunkKeys, citationMap);
    return {
      type: step.type,
      durationMs: step.durationMs,
      outcomeCode: step.outcomeCode,
      ...(step.toolName !== undefined ? { toolName: step.toolName } : {}),
      ...(step.orderId !== undefined ? { orderId: step.orderId } : {}),
      ...(step.tokenUsage !== undefined ? { tokenUsage: step.tokenUsage } : {}),
      ...(step.attempts !== undefined ? { attempts: step.attempts } : {}),
      ...(citations !== undefined ? { citations } : {}),
    };
  });

  return {
    id: run.id,
    runId: run.runId,
    outcome: run.outcome,
    ...(run.degraded !== null ? { degraded: run.degraded } : {}),
    stepCount: run.stepCount,
    llmCallCount: run.llmCallCount,
    tokensIn: run.tokensIn,
    tokensOut: run.tokensOut,
    latencyMs: run.latencyMs,
    steps,
    ...(run.proposedAction !== null
      ? { proposedAction: { tool: run.proposedAction.tool, orderId: run.proposedAction.orderId, amount: run.proposedAction.amount } }
      : {}),
    ...(run.refundDisposition !== null
      ? {
          refundDisposition: {
            kind: run.refundDisposition.kind,
            ...(run.refundDisposition.failedRuleCodes !== undefined ? { failedRuleCodes: run.refundDisposition.failedRuleCodes } : {}),
            ...(run.refundDisposition.approvalId !== undefined ? { approvalId: run.refundDisposition.approvalId } : {}),
          },
        }
      : {}),
    createdAt: run.createdAt.toISOString(),
  };
}

/**
 * Stage 1c, item 2 - `GET /v1/conversations`, `GET /v1/conversations/:id`.
 * Pure read model over the SAME repositories chat.service.ts already
 * writes through - this service never writes anything. `tenantId` is
 * always the caller's (an `AdminPrincipal.tenantId`), never read from a
 * request body or param (RULES.md §5). `customerRef` is returned in full
 * (never redacted) - this is the admin console, not a log line; nothing
 * in this file calls `Logger` with a conversation's `customerRef` or any
 * message/chunk text, satisfying "kept out of every log line" by simply
 * never logging at all here.
 */
@Injectable()
export class ConversationsAdminService {
  constructor(
    @Optional() @Inject(CONVERSATION_REPOSITORY) private readonly conversationRepository: ConversationRepository | undefined,
    @Optional() @Inject(MESSAGE_REPOSITORY) private readonly messageRepository: MessageRepository | undefined,
    @Optional() @Inject(AGENT_RUN_REPOSITORY) private readonly agentRunRepository: AgentRunRepository | undefined,
    @Optional() @Inject(POLICY_CHUNK_REPOSITORY) private readonly policyChunkRepository: PolicyChunkRepository | undefined,
  ) {}

  isConfigured(): boolean {
    return this.conversationRepository !== undefined && this.messageRepository !== undefined && this.agentRunRepository !== undefined;
  }

  async list(tenantId: string, query: SharedConversationListQuery): Promise<ConversationListResponse> {
    const repoQuery: ConversationListQuery = {
      ...(query.status !== undefined ? { status: query.status } : {}),
      ...(query.createdAfter !== undefined ? { createdAfter: new Date(query.createdAfter) } : {}),
      ...(query.createdBefore !== undefined ? { createdBefore: new Date(query.createdBefore) } : {}),
      ...(query.limit !== undefined ? { limit: query.limit } : {}),
      ...(query.cursor !== undefined ? { cursor: query.cursor } : {}),
    };
    const result = await this.conversationRepository!.list(tenantId, repoQuery);
    return { conversations: result.conversations.map(toSummary), ...(result.nextCursor ? { nextCursor: result.nextCursor } : {}) };
  }

  /** Null for a nonexistent id OR another tenant's id - identical either way, the caller turns this into a plain 404. */
  async getDetail(tenantId: string, id: string): Promise<ConversationDetailResponse | null> {
    const conversation = await this.conversationRepository!.findById(tenantId, id);
    if (!conversation) {
      return null;
    }

    const [messages, runs] = await Promise.all([
      this.messageRepository!.findAllForConversation(tenantId, id, ADMIN_CONVERSATION_DETAIL_MAX_MESSAGES),
      this.agentRunRepository!.findByConversation(tenantId, id),
    ]);

    const citationMap = await resolveCitationMap(tenantId, collectCitedChunkKeys(runs), this.policyChunkRepository);

    return {
      id: conversation.id,
      customerRef: conversation.customerRef,
      status: conversation.status,
      messageCount: conversation.messageCount,
      createdAt: conversation.createdAt.toISOString(),
      updatedAt: conversation.updatedAt.toISOString(),
      messages: messages.map((m) => ({ role: m.role, content: m.content, createdAt: m.createdAt.toISOString() })),
      runs: runs.map((run) => toAdminAgentRun(run, citationMap)),
    };
  }
}
