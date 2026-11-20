/**
 * Milestone 5, Stage 1a, amendment A6 - an opaque (to the client) cursor
 * encoding `{ createdAt, id }`, the exact keyset-pagination tie-breaker
 * `MessageRepository.findPageForConversation` uses against the EXISTING
 * `{ tenantId: 1, conversationId: 1, createdAt: 1 }` index (message.schema.ts)
 * - no new index. `id` alone is not monotonic/sortable in a way that's safe
 * to paginate on by itself (Mongo ObjectIds generally sort close to
 * creation order, but are not guaranteed to within the same second across
 * concurrent writers), so `createdAt` is the primary key and `id` only
 * breaks a tie between two messages with the identical millisecond
 * timestamp - exactly the compound shape the index already supports.
 *
 * The encoding itself (base64url of `${epochMillis}:${id}`) is deliberately
 * unparsed by the client (packages/shared's own ConversationMessagesQuerySchema
 * types it as a bare string) - this module is the only place that needs to
 * agree with itself on the format, so it can change without coordinating
 * with the widget.
 */
export interface MessageCursor {
  createdAtMs: number;
  id: string;
}

export function encodeMessageCursor(cursor: MessageCursor): string {
  return Buffer.from(`${cursor.createdAtMs}:${cursor.id}`, 'utf8').toString('base64url');
}

/** Returns undefined for a missing/empty input (the "no cursor yet" case), or for anything that fails to decode into the expected shape - a malformed cursor is never thrown on, only treated as "start from the beginning", same as an absent one. */
export function decodeMessageCursor(raw: string | undefined): MessageCursor | undefined {
  if (!raw) {
    return undefined;
  }
  try {
    const decoded = Buffer.from(raw, 'base64url').toString('utf8');
    const separatorIndex = decoded.indexOf(':');
    if (separatorIndex <= 0) {
      return undefined;
    }
    const createdAtMs = Number(decoded.slice(0, separatorIndex));
    const id = decoded.slice(separatorIndex + 1);
    if (!Number.isFinite(createdAtMs) || id.length === 0) {
      return undefined;
    }
    return { createdAtMs, id };
  } catch {
    return undefined;
  }
}
