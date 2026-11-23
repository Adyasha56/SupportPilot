import { randomUUID } from 'node:crypto';
import { MessagePageCursor, MessageRecord, MessageRepository } from '../message.repository';
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

  /** Mirrors MongooseMessageRepository's own ordering: oldest-first, createdAt then insertion order as the tie-breaker (randomUUID ids have no natural order, so insertion order stands in for it here). */
  async findPageForConversation(tenantId: string, conversationId: string, after: MessagePageCursor | undefined, limit: number): Promise<MessageRecord[]> {
    const matching = this.messages.filter((m) => m.tenantId === tenantId && m.conversationId === conversationId);
    const afterIndex = after ? matching.findIndex((m) => m.createdAt.getTime() === after.createdAtMs && m.id === after.id) : -1;
    const startIndex = after ? (afterIndex === -1 ? 0 : afterIndex + 1) : 0;
    return matching.slice(startIndex, startIndex + limit);
  }

  /** Mirrors MongooseMessageRepository's own "most recent `limit`, oldest-first" behavior. */
  async findAllForConversation(tenantId: string, conversationId: string, limit: number): Promise<MessageRecord[]> {
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
