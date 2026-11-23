import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { MessageDocument, MessageRole } from './schemas/message.schema';

export interface MessageRecord {
  id: string;
  tenantId: string;
  conversationId: string;
  role: MessageRole;
  content: string;
  createdAt: Date;
}

/** Milestone 5, Stage 1a, amendment A6 - the keyset-pagination tie-breaker (message-cursor.ts's own MessageCursor, re-declared here so this file has no dependency on the chat module). */
export interface MessagePageCursor {
  createdAtMs: number;
  id: string;
}

export interface MessageRepository {
  create(tenantId: string, conversationId: string, role: MessageRole, content: string): Promise<MessageRecord>;
  /** Last `limit` messages for this conversation, oldest first - the history window run-agent.ts's HistoryTurn[] is built from. */
  findRecentForConversation(tenantId: string, conversationId: string, limit: number): Promise<MessageRecord[]>;
  /**
   * Oldest-first page of messages strictly AFTER `after` (undefined = from
   * the beginning), bounded by `limit` - the widget polling endpoint's own
   * read path (apps/api/src/chat/conversation-messages.service.ts). Served
   * entirely from the EXISTING `{tenantId:1, conversationId:1, createdAt:1}`
   * index (message.schema.ts) - no new index.
   */
  findPageForConversation(tenantId: string, conversationId: string, after: MessagePageCursor | undefined, limit: number): Promise<MessageRecord[]>;
  /**
   * Stage 1c, item 2 - the admin console's conversation-detail view (never
   * the agent's own history window, which stays exactly
   * `findRecentForConversation` as documented in known-limitations.md's
   * "TTL deletes old messages even inside a still-active conversation"
   * entry). Returns up to `limit` messages, OLDEST first - for a
   * conversation longer than `limit`, the MOST RECENT `limit` messages are
   * kept (same "newest N, then reverse for display order" approach
   * `findRecentForConversation` already uses) so the admin always sees the
   * conversation's current state, never an arbitrarily truncated tail of
   * ancient history. This is not itself paginated - a full Milestone-6-
   * style paginated transcript view is future work if a conversation ever
   * genuinely needs one.
   */
  findAllForConversation(tenantId: string, conversationId: string, limit: number): Promise<MessageRecord[]>;
  /** Test/ops cleanup only. */
  deleteForTenant(tenantId: string): Promise<void>;
}

export const MESSAGE_REPOSITORY = Symbol('MESSAGE_REPOSITORY');

function toRecord(doc: MessageDocument): MessageRecord {
  return {
    id: doc._id.toString(),
    tenantId: doc.tenantId,
    conversationId: doc.conversationId,
    role: doc.role,
    content: doc.content,
    createdAt: doc.createdAt,
  };
}

@Injectable()
export class MongooseMessageRepository implements MessageRepository {
  constructor(@InjectModel('Message') private readonly model: Model<MessageDocument>) {}

  async create(tenantId: string, conversationId: string, role: MessageRole, content: string): Promise<MessageRecord> {
    const doc = await this.model.create({ tenantId, conversationId, role, content });
    return toRecord(doc);
  }

  async findRecentForConversation(tenantId: string, conversationId: string, limit: number): Promise<MessageRecord[]> {
    // Sort newest-first to use the limit efficiently via the index, then
    // reverse in memory so callers always receive oldest-first - the order
    // a conversation transcript/HistoryTurn[] is expected in.
    const docs = await this.model
      .find({ tenantId, conversationId })
      .sort({ createdAt: -1 })
      .limit(limit)
      .lean();
    return docs.map((doc) => toRecord(doc as unknown as MessageDocument)).reverse();
  }

  async findPageForConversation(tenantId: string, conversationId: string, after: MessagePageCursor | undefined, limit: number): Promise<MessageRecord[]> {
    const filter: Record<string, unknown> = { tenantId, conversationId };

    // A cursor whose `id` half isn't a valid ObjectId (corrupted/forged)
    // is treated exactly like no cursor at all (message-cursor.ts's own
    // "never throws" rule, carried through here) - never a 500.
    const afterObjectId = after ? toObjectIdOrUndefined(after.id) : undefined;
    if (after && afterObjectId) {
      filter.$or = [{ createdAt: { $gt: new Date(after.createdAtMs) } }, { createdAt: new Date(after.createdAtMs), _id: { $gt: afterObjectId } }];
    }

    const docs = await this.model.find(filter).sort({ createdAt: 1, _id: 1 }).limit(limit).lean();
    return docs.map((doc) => toRecord(doc as unknown as MessageDocument));
  }

  async findAllForConversation(tenantId: string, conversationId: string, limit: number): Promise<MessageRecord[]> {
    const docs = await this.model
      .find({ tenantId, conversationId })
      .sort({ createdAt: -1, _id: -1 })
      .limit(limit)
      .lean();
    return docs.map((doc) => toRecord(doc as unknown as MessageDocument)).reverse();
  }

  async deleteForTenant(tenantId: string): Promise<void> {
    await this.model.deleteMany({ tenantId });
  }
}

function toObjectIdOrUndefined(id: string): Types.ObjectId | undefined {
  try {
    return new Types.ObjectId(id);
  } catch {
    return undefined;
  }
}
