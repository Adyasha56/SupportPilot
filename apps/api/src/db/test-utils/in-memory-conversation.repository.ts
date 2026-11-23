import { generateConversationId } from '../conversation-id';
import {
  ConversationListQuery,
  ConversationListResult,
  ConversationRecord,
  ConversationRepository,
  decodeConversationCursor,
  encodeConversationCursor,
  resolveConversationListLimit,
} from '../conversation.repository';

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

  /** Mirrors MongooseConversationRepository.list's own filter/sort/cursor semantics in plain JS. */
  async list(tenantId: string, query: ConversationListQuery): Promise<ConversationListResult> {
    const limit = resolveConversationListLimit(query.limit);
    let matching = [...this.conversations.values()].filter((r) => r.tenantId === tenantId);

    if (query.status) {
      matching = matching.filter((r) => r.status === query.status);
    }
    if (query.createdAfter) {
      matching = matching.filter((r) => r.createdAt.getTime() >= query.createdAfter!.getTime());
    }
    if (query.createdBefore) {
      matching = matching.filter((r) => r.createdAt.getTime() < query.createdBefore!.getTime());
    }

    // Newest-first, id descending as the stable tiebreaker - same total order the real repository's `{createdAt: -1, _id: -1}` sort produces.
    matching.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));

    if (query.cursor) {
      const decoded = decodeConversationCursor(query.cursor);
      if (decoded) {
        const cursorCreatedAtMs = new Date(decoded.createdAt).getTime();
        matching = matching.filter(
          (r) => r.createdAt.getTime() < cursorCreatedAtMs || (r.createdAt.getTime() === cursorCreatedAtMs && r.id < decoded.id),
        );
      }
    }

    const page = matching.slice(0, limit);
    const hasMore = matching.length > limit;
    return { conversations: page, ...(hasMore && page.length > 0 ? { nextCursor: encodeConversationCursor(page[page.length - 1]) } : {}) };
  }

  async deleteForTenant(tenantId: string): Promise<void> {
    for (const [id, record] of this.conversations) {
      if (record.tenantId === tenantId) {
        this.conversations.delete(id);
      }
    }
  }
}
