import { randomBytes } from 'node:crypto';

/**
 * 128 bits of randomness, base64url-encoded (22 characters, no padding) -
 * never sequential, never derived from anything guessable (PROJECT.md's
 * Agent loop design, "unguessable conversation ids"). This IS the
 * Conversation document's own _id (see conversation.schema.ts) - base64url's
 * alphabet (A-Za-z0-9-_) is an exact subset of GENERIC_ID_PATTERN
 * (packages/shared/src/ids.ts), so it's valid against the shared id schema
 * with no new validation helper needed. Lives here (not packages/shared)
 * because node:crypto isn't available to a browser bundle (the future
 * web-widget package also depends on packages/shared).
 */
export function generateConversationId(): string {
  return randomBytes(16).toString('base64url');
}
