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

/**
 * Stage 1c, item 2 - the admin console's conversation list
 * (`GET /v1/conversations`). `createdAfter`/`createdBefore` are both
 * inclusive-exclusive the same way `ApprovalListQuery`'s own date
 * handling elsewhere in this project works: `createdAfter` is `$gte`,
 * `createdBefore` is `$lt`. `cursor` is opaque - only `encodeConversationCursor`/
 * `decodeConversationCursor` below know its shape.
 */
export interface ConversationListQuery {
  status?: ConversationStatus;
  createdAfter?: Date;
  createdBefore?: Date;
  limit?: number;
  cursor?: string;
}

export interface ConversationListResult {
  conversations: ConversationRecord[];
  nextCursor?: string;
}

export const MAX_CONVERSATION_LIST_LIMIT = 100;
export const DEFAULT_CONVERSATION_LIST_LIMIT = 20;

export interface ConversationRepository {
  create(tenantId: string, customerRef: string | null): Promise<ConversationRecord>;
  findById(tenantId: string, id: string): Promise<ConversationRecord | null>;
  /** Atomically increments messageCount and returns the new total - used both to persist a turn and to enforce the per-conversation length cap, without a separate read-then-write race. */
  incrementMessageCount(tenantId: string, id: string, by: number): Promise<number>;
  /**
   * Cursor-paginated, newest-first (`createdAt` descending, `_id`
   * descending as the stable tiebreaker for same-millisecond rows) - the
   * exact same keyset-pagination shape `ApprovalRepository.list` already
   * uses, so a future admin UI can treat both lists identically.
   */
  list(tenantId: string, query: ConversationListQuery): Promise<ConversationListResult>;
  /** Test/ops cleanup only. */
  deleteForTenant(tenantId: string): Promise<void>;
}

export const CONVERSATION_REPOSITORY = Symbol('CONVERSATION_REPOSITORY');

interface ConversationCursorPayload {
  createdAt: string;
  id: string;
}

/** Mirrors ApprovalRepository's own encodeCursor/decodeCursor exactly - same opaque base64url-JSON shape, same "never throws" contract. */
export function encodeConversationCursor(record: Pick<ConversationRecord, 'createdAt' | 'id'>): string {
  const payload: ConversationCursorPayload = { createdAt: record.createdAt.toISOString(), id: record.id };
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

/** Returns undefined for a malformed/tampered cursor - list() then just starts from the beginning, never a 500. */
export function decodeConversationCursor(cursor: string): ConversationCursorPayload | undefined {
  try {
    const payload = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as Partial<ConversationCursorPayload>;
    if (typeof payload.createdAt !== 'string' || typeof payload.id !== 'string') {
      return undefined;
    }
    return { createdAt: payload.createdAt, id: payload.id };
  } catch {
    return undefined;
  }
}

export function resolveConversationListLimit(limit: number | undefined): number {
  if (limit === undefined) {
    return DEFAULT_CONVERSATION_LIST_LIMIT;
  }
  return Math.min(Math.max(1, Math.trunc(limit)), MAX_CONVERSATION_LIST_LIMIT);
}

/**
 * The stable, descending (createdAt, _id) keyset-pagination filter - sort
 * is always `{ createdAt: -1, _id: -1 }`, so this is the standard "strictly
 * before the last seen row" predicate for that order, safe even when
 * several conversations share the same createdAt millisecond. `_id` here
 * is the conversation's own app-generated random string id (never an
 * ObjectId - see conversation.schema.ts), which is fine: the tiebreaker
 * only needs a stable total order, not a chronological one, since
 * `createdAt` is already the primary sort key.
 */
export function buildConversationListFilter(tenantId: string, query: ConversationListQuery): Record<string, unknown> {
  const filter: Record<string, unknown> = { tenantId };
  if (query.status) {
    filter.status = query.status;
  }
  if (query.createdAfter || query.createdBefore) {
    const createdAt: Record<string, Date> = {};
    if (query.createdAfter) {
      createdAt.$gte = query.createdAfter;
    }
    if (query.createdBefore) {
      createdAt.$lt = query.createdBefore;
    }
    filter.createdAt = createdAt;
  }
  if (query.cursor) {
    const decoded = decodeConversationCursor(query.cursor);
    if (decoded) {
      const createdAt = new Date(decoded.createdAt);
      filter.$or = [{ createdAt: { $lt: createdAt } }, { createdAt, _id: { $lt: decoded.id } }];
    }
  }
  return filter;
}

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
      { returnDocument: 'after' },
    );
    return doc?.messageCount ?? 0;
  }

  async list(tenantId: string, query: ConversationListQuery): Promise<ConversationListResult> {
    const limit = resolveConversationListLimit(query.limit);
    const filter = buildConversationListFilter(tenantId, query);
    // Fetch one extra row to know whether a next page exists, without a separate count query - same technique ApprovalRepository.list uses.
    const docs = (await this.model
      .find(filter)
      .sort({ createdAt: -1, _id: -1 })
      .limit(limit + 1)
      .lean()) as unknown as ConversationDocument[];

    const page = docs.slice(0, limit).map(toRecord);
    const hasMore = docs.length > limit;
    return { conversations: page, ...(hasMore && page.length > 0 ? { nextCursor: encodeConversationCursor(page[page.length - 1]) } : {}) };
  }

  async deleteForTenant(tenantId: string): Promise<void> {
    await this.model.deleteMany({ tenantId });
  }
}
