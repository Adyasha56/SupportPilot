import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { generateConversationId } from './conversation-id';
import { ConversationDocument, ConversationStatus } from './schemas/conversation.schema';

export interface ConversationRecord {
  id: string;
  tenantId: string;
  customerRef: string | null;
  status: ConversationStatus;
  messageCount: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface ConversationRepository {
  create(tenantId: string, customerRef: string | null): Promise<ConversationRecord>;
  findById(tenantId: string, id: string): Promise<ConversationRecord | null>;
  /** Atomically increments messageCount and returns the new total - used both to persist a turn and to enforce the per-conversation length cap, without a separate read-then-write race. */
  incrementMessageCount(tenantId: string, id: string, by: number): Promise<number>;
  /** Test/ops cleanup only. */
  deleteForTenant(tenantId: string): Promise<void>;
}

export const CONVERSATION_REPOSITORY = Symbol('CONVERSATION_REPOSITORY');

function toRecord(doc: ConversationDocument): ConversationRecord {
  return {
    id: doc._id,
    tenantId: doc.tenantId,
    customerRef: doc.customerRef,
    status: doc.status,
    messageCount: doc.messageCount,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
}

@Injectable()
export class MongooseConversationRepository implements ConversationRepository {
  constructor(@InjectModel('Conversation') private readonly model: Model<ConversationDocument>) {}

  async create(tenantId: string, customerRef: string | null): Promise<ConversationRecord> {
    const doc = await this.model.create({ _id: generateConversationId(), tenantId, customerRef, status: 'open', messageCount: 0 });
    return toRecord(doc);
  }

  async findById(tenantId: string, id: string): Promise<ConversationRecord | null> {
    const doc = await this.model.findOne({ _id: id, tenantId }).lean();
    return doc ? toRecord(doc as unknown as ConversationDocument) : null;
  }

  async incrementMessageCount(tenantId: string, id: string, by: number): Promise<number> {
    const doc = await this.model.findOneAndUpdate(
      { _id: id, tenantId },
      { $inc: { messageCount: by } },
      { new: true },
    );
    return doc?.messageCount ?? 0;
  }

  async deleteForTenant(tenantId: string): Promise<void> {
    await this.model.deleteMany({ tenantId });
  }
}
