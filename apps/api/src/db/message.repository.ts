import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { MessageDocument, MessageRole } from './schemas/message.schema';

export interface MessageRecord {
  id: string;
  tenantId: string;
  conversationId: string;
  role: MessageRole;
  content: string;
  createdAt: Date;
}

export interface MessageRepository {
  create(tenantId: string, conversationId: string, role: MessageRole, content: string): Promise<MessageRecord>;
  /** Last `limit` messages for this conversation, oldest first - the history window run-agent.ts's HistoryTurn[] is built from. */
  findRecentForConversation(tenantId: string, conversationId: string, limit: number): Promise<MessageRecord[]>;
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

  async deleteForTenant(tenantId: string): Promise<void> {
    await this.model.deleteMany({ tenantId });
  }
}
