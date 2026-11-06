import { randomBytes } from 'node:crypto';

/**
 * 128 bits of randomness, base64url-encoded, `r_`-prefixed - same shape and
 * reasoning as db/conversation-id.ts's generateConversationId, generated
 * fresh per chat.service.ts run BEFORE runAgent is called (it's one of
 * RunAgentInput's own required fields, used only for log/trace
 * correlation inside that run - never persisted as an AgentRun document's
 * _id, which Mongo assigns on insert). Lives in chat/, not db/, since
 * nothing about it is database-specific - it's handed to runAgent and
 * echoed into the ChatResult response before any persistence happens.
 */
export function generateRunId(): string {
  return `r_${randomBytes(16).toString('base64url')}`;
}
