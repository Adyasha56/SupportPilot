import { generateConversationId } from '../conversation-id';
import { ConversationRecord, ConversationRepository } from '../conversation.repository';

export class InMemoryConversationRepository implements ConversationRepository {
  private readonly conversations = new Map<string, ConversationRecord>();

  async create(tenantId: string, customerRef: string | null): Promise<ConversationRecord> {
    const now = new Date();
    const record: ConversationRecord = {
      id: generateConversationId(),
      tenantId,
      customerRef,
      status: 'open',
      messageCount: 0,
      createdAt: now,
      updatedAt: now,
    };
    this.conversations.set(record.id, record);
    return record;
  }

  async findById(tenantId: string, id: string): Promise<ConversationRecord | null> {
    const record = this.conversations.get(id);
    return record && record.tenantId === tenantId ? record : null;
  }

  async incrementMessageCount(tenantId: string, id: string, by: number): Promise<number> {
    const record = this.conversations.get(id);
    if (!record || record.tenantId !== tenantId) {
      return 0;
    }
    record.messageCount += by;
    record.updatedAt = new Date();
    return record.messageCount;
  }

  async deleteForTenant(tenantId: string): Promise<void> {
    for (const [id, record] of this.conversations) {
      if (record.tenantId === tenantId) {
        this.conversations.delete(id);
      }
    }
  }
}
