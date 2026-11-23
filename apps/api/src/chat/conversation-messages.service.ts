import { Inject, Injectable, Optional } from '@nestjs/common';
import { ConversationMessagesQuerySchema, ConversationMessagesResponse, GENERIC_ID_PATTERN } from '@supportpilot/shared';
import { ConversationRecord, ConversationRepository, CONVERSATION_REPOSITORY } from '../db/conversation.repository';
import { MessageRecord, MessageRepository, MESSAGE_REPOSITORY } from '../db/message.repository';
import { CustomerPublicKeyRepository, CUSTOMER_PUBLIC_KEY_REPOSITORY } from '../db/customer-public-key.repository';
import { ApiKeyScope } from '../db/schemas/api-key.schema';
import { RateLimiter } from '../auth/rate-limiter';
import { resolveIdentityWithLookup } from './identity-resolution';
import { decodeMessageCursor, encodeMessageCursor } from './message-cursor';
import { CHAT_SETTINGS } from './chat-settings.provider';
import { ChatSettings } from './chat.settings';
import { POLL_RATE_LIMITER, POLL_TENANT_RATE_LIMITER } from './poll-rate-limiter.provider';

export type ConversationMessagesErrorCode = 'NOT_CONFIGURED' | 'INVALID_REQUEST' | 'INVALID_CUSTOMER_TOKEN' | 'RATE_LIMITED' | 'NOT_FOUND';

export type ConversationMessagesResult =
  | { kind: 'success'; body: ConversationMessagesResponse; etag: string }
  | { kind: 'not_modified'; etag: string }
  | { kind: 'error'; code: ConversationMessagesErrorCode; message: string; retryAfterSeconds?: number };

export interface ConversationMessagesInput {
  tenantId: string;
  /** The key's own highest capability (same CurrentApiKeyScope chat.controller.ts uses), decides whether rawQuery.customerRef is honored - see identity-resolution.ts. */
  matchedScope: ApiKeyScope;
  conversationId: string;
  /** Unvalidated - ConversationMessagesQuerySchema.safeParse happens inside getMessages(), first thing after the id shape check. */
  rawQuery: unknown;
  /** The request's own `If-None-Match` header, verbatim - see computeEtag's own doc comment for the conditional-response design (Part 0, item P1). */
  ifNoneMatch?: string;
}

const GENERIC_NOT_FOUND_MESSAGE = 'Conversation not found.';
const GENERIC_INVALID_REQUEST_MESSAGE = 'The request is invalid.';
const GENERIC_INVALID_TOKEN_MESSAGE = 'The customer token is invalid, expired, or could not be verified.';

/**
 * A WEAK ETag (RFC 9110 - the response isn't byte-identical across calls
 * with the same value, only equivalent-enough: same count of messages)
 * derived from BOTH the conversation id AND its `messageCount` (Part 0,
 * item Q2) - messageCount alone is not resource-specific: two DIFFERENT
 * conversations can easily share the same message count (e.g. two brand
 * new ones), and an ETag that doesn't bind the resource it describes
 * could make a stale/reused `If-None-Match` from one conversation wrongly
 * read as "unchanged" against a different one. Binding the id makes that
 * structurally impossible, independent of (and in addition to) the
 * ownership check already gating whether this function is ever reached
 * for a given id at all (see getMessages's own doc comment on ordering).
 * `messageCount` already increments on every new customer/agent message
 * (chat.service.ts's `incrementMessageCount`); both fields were ALREADY
 * read for the ownership check just above this function's call site - no
 * extra read.
 */
function computeEtag(conversation: ConversationRecord): string {
  return `W/"${conversation.id}-${conversation.messageCount}"`;
}

/**
 * Milestone 5, Stage 1a, amendment A6 - GET /v1/chat/conversations/:id/messages.
 * Same split as ChatService: this returns a typed result, never throws an
 * HTTP exception itself; conversation-messages.controller.ts is the only
 * place that maps a result to a response
 * (conversation-messages-http-error.ts).
 *
 * ORDER (mirrors chat.service.ts's own pipeline, adapted for a read):
 *   1. database-configured check.
 *   2. conversationId SHAPE check - a malformed id is folded into the same
 *      404 as "doesn't exist", never its own distinguishable error (no
 *      format oracle).
 *   3. query validation (400 INVALID_REQUEST).
 *   4. identity resolution - a present-but-invalid customer token is
 *      ALWAYS 401 INVALID_CUSTOMER_TOKEN, the same uniform rule
 *      chat.service.ts enforces; a public-scope caller's own
 *      `customerRef` query param is never consulted (resolveIdentity
 *      itself enforces this).
 *   5. the poll-TENANT rate limiter (POLL_TENANT_RATE_LIMITER, Part 0 item
 *      P1) - many visitors of the same tenant's widget, summed - then the
 *      poll-CONVERSATION rate limiter (POLL_RATE_LIMITER), keyed by
 *      `${tenantId}:${conversationId}` - one visitor's own stream. Both
 *      checked BEFORE the conversation read below, so a flood (real
 *      visitors or a guessed id) is rejected as cheaply as possible. (The
 *      per-IP/per-API-key guard-level buckets ran even earlier, in
 *      PollApiKeyGuard, before this service is ever called at all.)
 *   6. conversation lookup, tenant-scoped, with the SAME null-safe
 *      ownership match chat.service.ts's resolveConversation uses -
 *      a mismatch and a nonexistent id are the IDENTICAL 404.
 *   7. the ETag conditional check (Part 0 item P1 - "a conditional response
 *      so an unchanged poll is cheap"): computed from the conversation we
 *      JUST read for step 6, at no extra cost. A matching `If-None-Match`
 *      short-circuits here - `kind: 'not_modified'`, the message-page query
 *      below never runs at all, which is the actual cost this is meant to
 *      avoid (a ranged index scan, however cheap, beats doing it on every
 *      single poll when nothing changed). Part 0, item Q2 - this step is
 *      STRUCTURALLY unreachable for a mismatched/nonexistent id, since
 *      step 6 already returned 404 before this line is ever reached - a
 *      304-vs-404 response can never be used to probe whether a
 *      conversation exists or belongs to the caller, however the
 *      `If-None-Match` header is forged.
 *   8. the message page itself, oldest-first, bounded by
 *      ChatSettings.pollPageSize, served off the existing
 *      {tenantId,conversationId,createdAt} index.
 */
@Injectable()
export class ConversationMessagesService {
  private readonly clock: () => Date;

  constructor(
    @Optional() @Inject(CONVERSATION_REPOSITORY) private readonly conversationRepository: ConversationRepository | undefined,
    @Optional() @Inject(MESSAGE_REPOSITORY) private readonly messageRepository: MessageRepository | undefined,
    @Optional() @Inject(CUSTOMER_PUBLIC_KEY_REPOSITORY) private readonly customerPublicKeyRepository: CustomerPublicKeyRepository | undefined,
    @Inject(CHAT_SETTINGS) private readonly settings: ChatSettings,
    @Inject(POLL_RATE_LIMITER) private readonly pollRateLimiter: RateLimiter,
    @Inject(POLL_TENANT_RATE_LIMITER) private readonly pollTenantRateLimiter: RateLimiter,
    @Optional() clock?: () => Date,
  ) {
    this.clock = clock ?? (() => new Date());
  }

  async getMessages(input: ConversationMessagesInput): Promise<ConversationMessagesResult> {
    if (!this.conversationRepository || !this.messageRepository || !this.customerPublicKeyRepository) {
      return this.error('NOT_CONFIGURED', 'The database is not configured.');
    }

    if (!GENERIC_ID_PATTERN.test(input.conversationId)) {
      return this.error('NOT_FOUND', GENERIC_NOT_FOUND_MESSAGE);
    }

    const parsedQuery = ConversationMessagesQuerySchema.safeParse(input.rawQuery);
    if (!parsedQuery.success) {
      return this.error('INVALID_REQUEST', GENERIC_INVALID_REQUEST_MESSAGE);
    }
    const query = parsedQuery.data;

    const identity = await resolveIdentityWithLookup(input.matchedScope, query, input.tenantId, this.customerPublicKeyRepository, this.clock);
    if (identity.kind === 'invalid_token') {
      return this.error('INVALID_CUSTOMER_TOKEN', GENERIC_INVALID_TOKEN_MESSAGE);
    }
    const verifiedCustomerRef = identity.kind === 'identified' ? identity.customerRef : undefined;

    const tenantDecision = this.pollTenantRateLimiter.tryConsume(input.tenantId);
    if (!tenantDecision.allowed) {
      return this.error('RATE_LIMITED', 'Too many polling requests for this tenant.', Math.ceil(tenantDecision.retryAfterMs / 1000));
    }
    const pollDecision = this.pollRateLimiter.tryConsume(`${input.tenantId}:${input.conversationId}`);
    if (!pollDecision.allowed) {
      return this.error('RATE_LIMITED', 'Too many requests for this conversation.', Math.ceil(pollDecision.retryAfterMs / 1000));
    }

    const conversation = await this.conversationRepository.findById(input.tenantId, input.conversationId);
    if (!conversation || (conversation.customerRef ?? null) !== (verifiedCustomerRef ?? null)) {
      return this.error('NOT_FOUND', GENERIC_NOT_FOUND_MESSAGE);
    }

    const etag = computeEtag(conversation);
    if (input.ifNoneMatch !== undefined && input.ifNoneMatch === etag) {
      return { kind: 'not_modified', etag };
    }

    const after = decodeMessageCursor(query.after);
    const page = await this.messageRepository.findPageForConversation(input.tenantId, input.conversationId, after, this.settings.pollPageSize);

    return {
      kind: 'success',
      etag,
      body: {
        messages: page.map((m) => ({ role: m.role, content: m.content, createdAt: m.createdAt.toISOString() })),
        nextCursor: this.computeNextCursor(page, query.after),
      },
    };
  }

  private computeNextCursor(page: MessageRecord[], priorCursor: string | undefined): string | null {
    if (page.length > 0) {
      const last = page[page.length - 1];
      return encodeMessageCursor({ createdAtMs: last.createdAt.getTime(), id: last.id });
    }
    return priorCursor ?? null;
  }

  private error(code: ConversationMessagesErrorCode, message: string, retryAfterSeconds?: number): ConversationMessagesResult {
    return { kind: 'error', code, message, ...(retryAfterSeconds !== undefined ? { retryAfterSeconds } : {}) };
  }
}
