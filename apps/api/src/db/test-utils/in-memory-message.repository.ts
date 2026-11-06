import { randomUUID } from 'node:crypto';
import { MessageRecord, MessageRepository } from '../message.repository';
import { MessageRole } from '../schemas/message.schema';

export class InMemoryMessageRepository implements MessageRepository {
  private readonly messages: MessageRecord[] = [];

  async create(tenantId: string, conversationId: string, role: MessageRole, content: string): Promise<MessageRecord> {
    const record: MessageRecord = { id: randomUUID(), tenantId, conversationId, role, content, createdAt: new Date() };
    this.messages.push(record);
    return record;
  }

  async findRecentForConversation(tenantId: string, conversationId: string, limit: number): Promise<MessageRecord[]> {
    return this.messages
      .filter((m) => m.tenantId === tenantId && m.conversationId === conversationId)
      .slice(-limit);
  }

  async deleteForTenant(tenantId: string): Promise<void> {
    for (let i = this.messages.length - 1; i >= 0; i--) {
      if (this.messages[i].tenantId === tenantId) {
        this.messages.splice(i, 1);
      }
    }
  }
}
