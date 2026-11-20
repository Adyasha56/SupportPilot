import { z } from 'zod';

/**
 * Milestone 5, Stage 1a - the widget's polling read endpoint
 * (GET /v1/chat/conversations/:id/messages). Role/content/createdAt only -
 * never a chunk's embedding, a citation, or anything else a transcript
 * doesn't need. `cursor` is deliberately opaque here (a plain string, never
 * parsed client-side) - only the server (apps/api/src/chat/message-cursor.ts)
 * knows its internal shape, so that shape can change without this schema
 * (or the widget) ever needing to change too.
 */
export const ConversationMessageSchema = z.object({
  role: z.enum(['customer', 'agent']),
  content: z.string(),
  createdAt: z.string(),
});
export type ConversationMessage = z.infer<typeof ConversationMessageSchema>;

export const ConversationMessagesResponseSchema = z.object({
  messages: z.array(ConversationMessageSchema),
  /**
   * The cursor value to send as `after` on the NEXT poll - null only when
   * there is truly nothing to advance to yet (no `after` was sent and no
   * message exists yet). Always present (never omitted) once at least one
   * message has ever been returned across the life of a poll loop, even on
   * a call that itself returned zero NEW messages (echoes the caller's own
   * `after` back unchanged in that case) - so a polling client's loop is
   * always just "send `after: response.nextCursor` next time", never a
   * special case for "nothing changed this round".
   */
  nextCursor: z.string().nullable(),
});
export type ConversationMessagesResponse = z.infer<typeof ConversationMessagesResponseSchema>;

/**
 * Query params for the same endpoint. `customerRef`/`customerToken` mirror
 * ChatRequestSchema's own fields and are governed by the exact same rule
 * (see identity-resolution.ts): `customerRef` is honored ONLY for a
 * secret-scope caller (already fully trusted), silently ignored for a
 * public-scope one; `customerToken` is how a public-scope (widget) caller
 * asserts identity instead. `after` is the opaque cursor from a prior
 * response's `nextCursor` - omitted on the very first poll.
 */
export const ConversationMessagesQuerySchema = z.object({
  after: z.string().max(200).optional(),
  customerRef: z.string().max(200).optional(),
  customerToken: z.string().max(2000).optional(),
});
export type ConversationMessagesQuery = z.infer<typeof ConversationMessagesQuerySchema>;
