import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { InMemoryConversationRepository } from '../db/test-utils/in-memory-conversation.repository';
import { InMemoryMessageRepository } from '../db/test-utils/in-memory-message.repository';
import { InMemoryCustomerPublicKeyRepository } from '../db/test-utils/in-memory-customer-public-key.repository';
import { signCustomerToken } from '../agent/identity/customer-token';
import { RateLimiter } from '../auth/rate-limiter';
import { ConversationMessagesService } from './conversation-messages.service';
import { ChatSettings } from './chat.settings';
import { encodeMessageCursor } from './message-cursor';

function makeSettings(overrides: Partial<ChatSettings> = {}): ChatSettings {
  return {
    historyWindowSize: 10,
    historyMaxChars: 6000,
    maxMessagesPerConversation: 50,
    maxBodyBytes: 32_000,
    rateLimitIpMaxRequests: 1000,
    rateLimitIpWindowMs: 60_000,
    rateLimitIpMaxEntries: 1000,
    rateLimitApiKeyMaxRequests: 1000,
    rateLimitApiKeyWindowMs: 60_000,
    rateLimitApiKeyMaxEntries: 1000,
    rateLimitTenantMaxRequests: 1000,
    rateLimitTenantWindowMs: 60_000,
    rateLimitTenantMaxEntries: 1000,
    rateLimitCustomerRefMaxRequests: 1000,
    rateLimitCustomerRefWindowMs: 60_000,
    rateLimitCustomerRefMaxEntries: 1000,
    inFlightMaxRuns: 3,
    inFlightMaxQueued: 2,
    inFlightRetryAfterSeconds: 5,
    conversationLockTtlMs: 35_000,
    conversationLockMaxEntries: 1000,
    httpDeadlineMs: 35_000,
    retentionDays: 30,
    maxActiveCustomerKeysPerTenant: 5,
    tenantDailyGenerateBudget: 50,
    pollPageSize: 50,
    pollRateLimitMaxRequests: 100,
    pollRateLimitWindowMs: 600_000,
    pollRateLimitMaxEntries: 1000,
    pollTenantRateLimitMaxRequests: 1000,
    pollTenantRateLimitWindowMs: 60_000,
    pollTenantRateLimitMaxEntries: 1000,
    pollGuardIpRateLimitMaxRequests: 1000,
    pollGuardIpRateLimitWindowMs: 60_000,
    pollGuardIpRateLimitMaxEntries: 1000,
    pollGuardApiKeyRateLimitMaxRequests: 1000,
    pollGuardApiKeyRateLimitWindowMs: 60_000,
    pollGuardApiKeyRateLimitMaxEntries: 1000,
    ...overrides,
  };
}

function makeService(opts: {
  conversationRepository?: InMemoryConversationRepository;
  messageRepository?: InMemoryMessageRepository;
  customerPublicKeyRepository?: InMemoryCustomerPublicKeyRepository;
  settings?: Partial<ChatSettings>;
  pollRateLimiter?: RateLimiter;
  pollTenantRateLimiter?: RateLimiter;
} = {}): {
  service: ConversationMessagesService;
  conversationRepository: InMemoryConversationRepository;
  messageRepository: InMemoryMessageRepository;
  customerPublicKeyRepository: InMemoryCustomerPublicKeyRepository;
} {
  const conversationRepository = opts.conversationRepository ?? new InMemoryConversationRepository();
  const messageRepository = opts.messageRepository ?? new InMemoryMessageRepository();
  const customerPublicKeyRepository = opts.customerPublicKeyRepository ?? new InMemoryCustomerPublicKeyRepository();
  const settings = makeSettings(opts.settings);
  const pollRateLimiter = opts.pollRateLimiter ?? new RateLimiter({ maxRequests: 1000, windowMs: 60_000, maxEntries: 1000 }, () => new Date());
  const pollTenantRateLimiter = opts.pollTenantRateLimiter ?? new RateLimiter({ maxRequests: 1000, windowMs: 60_000, maxEntries: 1000 }, () => new Date());

  const service = new ConversationMessagesService(
    conversationRepository,
    messageRepository,
    customerPublicKeyRepository,
    settings,
    pollRateLimiter,
    pollTenantRateLimiter,
  );
  return { service, conversationRepository, messageRepository, customerPublicKeyRepository };
}

function registerCustomerKey() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const jwk = publicKey.export({ format: 'jwk' }) as { x: string };
  return { privateKey, publicKeyX: jwk.x };
}

describe('ConversationMessagesService', () => {
  it('returns NOT_CONFIGURED when a required repository is missing (no database)', async () => {
    const settings = makeSettings();
    const pollRateLimiter = new RateLimiter({ maxRequests: 100, windowMs: 60_000, maxEntries: 100 }, () => new Date());
    const pollTenantRateLimiter = new RateLimiter({ maxRequests: 100, windowMs: 60_000, maxEntries: 100 }, () => new Date());
    const service = new ConversationMessagesService(undefined, undefined, undefined, settings, pollRateLimiter, pollTenantRateLimiter);

    const result = await service.getMessages({ tenantId: 'acme', matchedScope: 'public', conversationId: 'conv_1', rawQuery: {} });

    expect(result).toMatchObject({ kind: 'error', code: 'NOT_CONFIGURED' });
  });

  it('a malformed conversation id gets the SAME 404 as a nonexistent one - never a distinguishable error', async () => {
    const { service } = makeService();

    const result = await service.getMessages({ tenantId: 'acme', matchedScope: 'public', conversationId: 'has spaces/slashes', rawQuery: {} });

    expect(result).toMatchObject({ kind: 'error', code: 'NOT_FOUND', message: 'Conversation not found.' });
  });

  it('a nonexistent (but well-formed) conversation id is a 404 with the identical message', async () => {
    const { service } = makeService();

    const result = await service.getMessages({ tenantId: 'acme', matchedScope: 'public', conversationId: 'doesNotExist12345678', rawQuery: {} });

    expect(result).toMatchObject({ kind: 'error', code: 'NOT_FOUND', message: 'Conversation not found.' });
  });

  it('an invalid query (customerToken way over the length cap) is INVALID_REQUEST', async () => {
    const { service } = makeService();

    const result = await service.getMessages({
      tenantId: 'acme',
      matchedScope: 'public',
      conversationId: 'doesNotExist12345678',
      rawQuery: { customerToken: 'x'.repeat(3000) },
    });

    expect(result).toMatchObject({ kind: 'error', code: 'INVALID_REQUEST' });
  });

  it('a present-but-invalid customer token is always 401 INVALID_CUSTOMER_TOKEN, uniform regardless of why', async () => {
    const { service, conversationRepository } = makeService();
    const conversation = await conversationRepository.create('acme', null);

    const result = await service.getMessages({
      tenantId: 'acme',
      matchedScope: 'public',
      conversationId: conversation.id,
      rawQuery: { customerToken: 'not-a-real-token' },
    });

    expect(result).toMatchObject({ kind: 'error', code: 'INVALID_CUSTOMER_TOKEN' });
  });

  it('an anonymous caller can read an anonymous conversation', async () => {
    const { service, conversationRepository, messageRepository } = makeService();
    const conversation = await conversationRepository.create('acme', null);
    await messageRepository.create('acme', conversation.id, 'customer', 'hello');
    await messageRepository.create('acme', conversation.id, 'agent', 'hi there');

    const result = await service.getMessages({ tenantId: 'acme', matchedScope: 'public', conversationId: conversation.id, rawQuery: {} });

    expect(result.kind).toBe('success');
    if (result.kind === 'success') {
      expect(result.body.messages).toEqual([
        { role: 'customer', content: 'hello', createdAt: expect.any(String) },
        { role: 'agent', content: 'hi there', createdAt: expect.any(String) },
      ]);
      expect(result.body.nextCursor).not.toBeNull();
    }
  });

  it('an identified caller can read their OWN conversation via a verified customerToken', async () => {
    const { service, conversationRepository, messageRepository, customerPublicKeyRepository } = makeService();
    const { privateKey, publicKeyX } = registerCustomerKey();
    await customerPublicKeyRepository.register('acme', 1, publicKeyX, 5);
    const conversation = await conversationRepository.create('acme', 'cust_1');
    await messageRepository.create('acme', conversation.id, 'customer', 'where is my order');

    const token = signCustomerToken({ tenantId: 'acme', customerRef: 'cust_1', expiresAt: Date.now() + 60_000, kid: 1 }, privateKey);
    const result = await service.getMessages({
      tenantId: 'acme',
      matchedScope: 'public',
      conversationId: conversation.id,
      rawQuery: { customerToken: token },
    });

    expect(result.kind).toBe('success');
  });

  it("another customer's conversation is the SAME 404 - never a leak that it exists, never its content", async () => {
    const { service, conversationRepository, messageRepository, customerPublicKeyRepository } = makeService();
    const { privateKey, publicKeyX } = registerCustomerKey();
    await customerPublicKeyRepository.register('acme', 1, publicKeyX, 5);
    const conversation = await conversationRepository.create('acme', 'cust_owner');
    await messageRepository.create('acme', conversation.id, 'customer', 'secret owner content');

    const attackerToken = signCustomerToken({ tenantId: 'acme', customerRef: 'cust_attacker', expiresAt: Date.now() + 60_000, kid: 1 }, privateKey);
    const result = await service.getMessages({
      tenantId: 'acme',
      matchedScope: 'public',
      conversationId: conversation.id,
      rawQuery: { customerToken: attackerToken },
    });

    expect(result).toMatchObject({ kind: 'error', code: 'NOT_FOUND', message: 'Conversation not found.' });
  });

  it('an anonymous caller cannot read an identified conversation (mismatch, not a leak)', async () => {
    const { service, conversationRepository } = makeService();
    const conversation = await conversationRepository.create('acme', 'cust_owner');

    const result = await service.getMessages({ tenantId: 'acme', matchedScope: 'public', conversationId: conversation.id, rawQuery: {} });

    expect(result).toMatchObject({ kind: 'error', code: 'NOT_FOUND', message: 'Conversation not found.' });
  });

  it('a public-scope caller\'s own customerRef query param is silently ignored - it can never use it to claim another identity', async () => {
    const { service, conversationRepository } = makeService();
    const conversation = await conversationRepository.create('acme', 'cust_owner');

    const result = await service.getMessages({
      tenantId: 'acme',
      matchedScope: 'public',
      conversationId: conversation.id,
      rawQuery: { customerRef: 'cust_owner' },
    });

    // customerRef is never honored for public scope, so this is still anonymous vs identified - a 404.
    expect(result).toMatchObject({ kind: 'error', code: 'NOT_FOUND' });
  });

  it('a secret-scope caller MAY assert customerRef directly (already fully trusted)', async () => {
    const { service, conversationRepository, messageRepository } = makeService();
    const conversation = await conversationRepository.create('acme', 'cust_owner');
    await messageRepository.create('acme', conversation.id, 'customer', 'hi');

    const result = await service.getMessages({
      tenantId: 'acme',
      matchedScope: 'secret',
      conversationId: conversation.id,
      rawQuery: { customerRef: 'cust_owner' },
    });

    expect(result.kind).toBe('success');
  });

  it('tenant isolation: the same conversation id under a different tenant is never found', async () => {
    const { service, conversationRepository } = makeService();
    const conversation = await conversationRepository.create('acme', null);

    const result = await service.getMessages({ tenantId: 'other-tenant', matchedScope: 'public', conversationId: conversation.id, rawQuery: {} });

    expect(result).toMatchObject({ kind: 'error', code: 'NOT_FOUND' });
  });

  it('the three distinguishable "can\'t read this" cases - other tenant, other customer, nonexistent id - return BYTE-IDENTICAL result bodies', async () => {
    const { service, conversationRepository, messageRepository, customerPublicKeyRepository } = makeService();
    const { privateKey, publicKeyX } = registerCustomerKey();
    await customerPublicKeyRepository.register('acme', 1, publicKeyX, 5);
    const conversation = await conversationRepository.create('acme', 'cust_owner');
    await messageRepository.create('acme', conversation.id, 'customer', 'owner-only secret content');
    const attackerToken = signCustomerToken({ tenantId: 'acme', customerRef: 'cust_attacker', expiresAt: Date.now() + 60_000, kid: 1 }, privateKey);

    // Case 1: a different tenant, same conversation id.
    const otherTenantResult = await service.getMessages({
      tenantId: 'other-tenant',
      matchedScope: 'public',
      conversationId: conversation.id,
      rawQuery: {},
    });
    // Case 2: the right tenant, a different (verified) customer.
    const otherCustomerResult = await service.getMessages({
      tenantId: 'acme',
      matchedScope: 'public',
      conversationId: conversation.id,
      rawQuery: { customerToken: attackerToken },
    });
    // Case 3: the right tenant, a conversation id that was never created at all.
    const nonexistentResult = await service.getMessages({
      tenantId: 'acme',
      matchedScope: 'public',
      conversationId: 'doesNotExistAtAll12345',
      rawQuery: { customerToken: attackerToken },
    });

    expect(otherTenantResult).toEqual({ kind: 'error', code: 'NOT_FOUND', message: 'Conversation not found.' });
    expect(otherCustomerResult).toEqual(otherTenantResult);
    expect(nonexistentResult).toEqual(otherTenantResult);
    // And the secret content genuinely never reached any of the three results.
    expect(JSON.stringify([otherTenantResult, otherCustomerResult, nonexistentResult])).not.toContain('owner-only secret content');
  });

  it('paginates with a cursor, bounded by pollPageSize, and advances nextCursor each call', async () => {
    const { service, conversationRepository, messageRepository } = makeService({ settings: { pollPageSize: 2 } });
    const conversation = await conversationRepository.create('acme', null);
    for (let i = 1; i <= 3; i++) {
      await messageRepository.create('acme', conversation.id, 'customer', `msg${i}`);
    }

    const first = await service.getMessages({ tenantId: 'acme', matchedScope: 'public', conversationId: conversation.id, rawQuery: {} });
    expect(first.kind).toBe('success');
    if (first.kind !== 'success') return;
    expect(first.body.messages.map((m) => m.content)).toEqual(['msg1', 'msg2']);

    const second = await service.getMessages({
      tenantId: 'acme',
      matchedScope: 'public',
      conversationId: conversation.id,
      rawQuery: { after: first.body.nextCursor! },
    });
    expect(second.kind).toBe('success');
    if (second.kind !== 'success') return;
    expect(second.body.messages.map((m) => m.content)).toEqual(['msg3']);
  });

  it('polling again with no new messages echoes the prior cursor back unchanged, never null', async () => {
    const { service, conversationRepository, messageRepository } = makeService();
    const conversation = await conversationRepository.create('acme', null);
    const message = await messageRepository.create('acme', conversation.id, 'customer', 'only message');
    const cursor = encodeMessageCursor({ createdAtMs: message.createdAt.getTime(), id: message.id });

    const result = await service.getMessages({ tenantId: 'acme', matchedScope: 'public', conversationId: conversation.id, rawQuery: { after: cursor } });

    expect(result.kind).toBe('success');
    if (result.kind === 'success') {
      expect(result.body.messages).toEqual([]);
      expect(result.body.nextCursor).toBe(cursor);
    }
  });

  it("the dedicated poll rate limiter rejects once its bucket (keyed by tenant+conversation) is exhausted", async () => {
    const pollRateLimiter = new RateLimiter({ maxRequests: 1, windowMs: 60_000, maxEntries: 100 }, () => new Date());
    const { service, conversationRepository } = makeService({ pollRateLimiter });
    const conversation = await conversationRepository.create('acme', null);

    const ok = await service.getMessages({ tenantId: 'acme', matchedScope: 'public', conversationId: conversation.id, rawQuery: {} });
    expect(ok.kind).toBe('success');

    const limited = await service.getMessages({ tenantId: 'acme', matchedScope: 'public', conversationId: conversation.id, rawQuery: {} });
    expect(limited).toMatchObject({ kind: 'error', code: 'RATE_LIMITED' });
    expect((limited as { retryAfterSeconds?: number }).retryAfterSeconds).toBeGreaterThan(0);
  });

  it('Part 0 item P1: the NEW per-tenant poll limiter rejects once ITS bucket is exhausted, independent of the per-conversation one', async () => {
    const pollTenantRateLimiter = new RateLimiter({ maxRequests: 1, windowMs: 60_000, maxEntries: 100 }, () => new Date());
    const { service, conversationRepository } = makeService({ pollTenantRateLimiter });
    const conversation = await conversationRepository.create('acme', null);

    const ok = await service.getMessages({ tenantId: 'acme', matchedScope: 'public', conversationId: conversation.id, rawQuery: {} });
    expect(ok.kind).toBe('success');

    const limited = await service.getMessages({ tenantId: 'acme', matchedScope: 'public', conversationId: conversation.id, rawQuery: {} });
    expect(limited).toMatchObject({ kind: 'error', code: 'RATE_LIMITED', message: 'Too many polling requests for this tenant.' });
  });

  it(
    'Part 0 item P1 - the two-limiter INTERACTION under several simulated visitors: the per-tenant bucket catches ' +
      'aggregate load across many conversations that each individual per-conversation bucket, alone, would never see',
    async () => {
      // Five independent "visitors" = five different conversations under the SAME tenant. Each
      // visitor's own per-conversation bucket is generous (20) - no single visitor is anywhere
      // near its own limit. The TENANT bucket (8) is what actually catches the combined load,
      // proving the two limiters interact correctly rather than one silently making the other
      // irrelevant.
      const pollRateLimiter = new RateLimiter({ maxRequests: 20, windowMs: 60_000, maxEntries: 100 }, () => new Date());
      const pollTenantRateLimiter = new RateLimiter({ maxRequests: 8, windowMs: 60_000, maxEntries: 100 }, () => new Date());
      const { service, conversationRepository } = makeService({ pollRateLimiter, pollTenantRateLimiter });

      const visitorCount = 5;
      const conversations = await Promise.all(
        Array.from({ length: visitorCount }, () => conversationRepository.create('acme', null)),
      );

      const outcomes: string[] = [];
      // Round-robin: visitor 0 polls, then visitor 1, ... then back to 0 - exactly what several
      // independent polling loops interleaved on one event loop would produce. 2 rounds = 10
      // total requests across 5 visitors (2 each) - well under any ONE visitor's own 20-request
      // bucket, but over the shared tenant bucket of 8.
      for (let round = 0; round < 2; round++) {
        for (const conversation of conversations) {
          const result = await service.getMessages({ tenantId: 'acme', matchedScope: 'public', conversationId: conversation.id, rawQuery: {} });
          outcomes.push(result.kind === 'error' ? result.code : result.kind);
        }
      }

      const successCount = outcomes.filter((o) => o === 'success').length;
      const rateLimitedCount = outcomes.filter((o) => o === 'RATE_LIMITED').length;
      expect(successCount).toBe(8); // exactly the tenant bucket's own cap - never more.
      expect(rateLimitedCount).toBe(10 - 8);
      // And no individual visitor's own per-conversation bucket (cap 20) was ever the cause -
      // confirm by checking the SAME scenario with the tenant limiter effectively unbounded.
      const { service: unboundedTenantService } = makeService({
        pollRateLimiter: new RateLimiter({ maxRequests: 20, windowMs: 60_000, maxEntries: 100 }, () => new Date()),
        pollTenantRateLimiter: new RateLimiter({ maxRequests: 1000, windowMs: 60_000, maxEntries: 100 }, () => new Date()),
        conversationRepository,
      });
      const unboundedOutcomes: string[] = [];
      for (let round = 0; round < 2; round++) {
        for (const conversation of conversations) {
          const result = await unboundedTenantService.getMessages({ tenantId: 'acme', matchedScope: 'public', conversationId: conversation.id, rawQuery: {} });
          unboundedOutcomes.push(result.kind === 'error' ? result.code : result.kind);
        }
      }
      expect(unboundedOutcomes.every((o) => o === 'success')).toBe(true);
    },
  );

  it('an unchanged conversation returns kind: not_modified when If-None-Match matches the current ETag, and never queries for messages', async () => {
    const conversationRepository = new InMemoryConversationRepository();
    const realMessageRepository = new InMemoryMessageRepository();
    let findPageCalls = 0;
    const spyingMessageRepository: InMemoryMessageRepository = Object.create(realMessageRepository, {
      findPageForConversation: {
        value: (...args: Parameters<InMemoryMessageRepository['findPageForConversation']>) => {
          findPageCalls++;
          return realMessageRepository.findPageForConversation(...args);
        },
      },
    });
    const { service } = makeService({ conversationRepository, messageRepository: spyingMessageRepository });
    const conversation = await conversationRepository.create('acme', null);
    await realMessageRepository.create('acme', conversation.id, 'customer', 'hello');

    const first = await service.getMessages({ tenantId: 'acme', matchedScope: 'public', conversationId: conversation.id, rawQuery: {} });
    expect(first.kind).toBe('success');
    if (first.kind !== 'success') return;
    expect(findPageCalls).toBe(1);

    const second = await service.getMessages({
      tenantId: 'acme',
      matchedScope: 'public',
      conversationId: conversation.id,
      rawQuery: {},
      ifNoneMatch: first.etag,
    });
    expect(second).toEqual({ kind: 'not_modified', etag: first.etag });
    expect(findPageCalls).toBe(1); // still 1 - the second call never reached the message query at all.
  });

  it('the ETag changes once a new message is added, so a stale If-None-Match no longer short-circuits', async () => {
    const { service, conversationRepository, messageRepository } = makeService();
    const conversation = await conversationRepository.create('acme', null);
    await messageRepository.create('acme', conversation.id, 'customer', 'hello');

    const first = await service.getMessages({ tenantId: 'acme', matchedScope: 'public', conversationId: conversation.id, rawQuery: {} });
    expect(first.kind).toBe('success');
    if (first.kind !== 'success') return;

    await conversationRepository.incrementMessageCount('acme', conversation.id, 2);
    await messageRepository.create('acme', conversation.id, 'agent', 'reply');

    const second = await service.getMessages({
      tenantId: 'acme',
      matchedScope: 'public',
      conversationId: conversation.id,
      rawQuery: {},
      ifNoneMatch: first.etag,
    });
    expect(second.kind).toBe('success');
    if (second.kind === 'success') {
      expect(second.etag).not.toBe(first.etag);
      expect(second.body.messages.map((m) => m.content)).toEqual(['hello', 'reply']);
    }
  });

  it('Part 0, item Q2 - two DIFFERENT conversations with the identical messageCount get DIFFERENT ETags (the id is bound into it)', async () => {
    const { service, conversationRepository, messageRepository } = makeService();
    const conversationA = await conversationRepository.create('acme', null);
    const conversationB = await conversationRepository.create('acme', null);
    await messageRepository.create('acme', conversationA.id, 'customer', 'hello from A');
    await messageRepository.create('acme', conversationB.id, 'customer', 'hello from B');

    const resultA = await service.getMessages({ tenantId: 'acme', matchedScope: 'public', conversationId: conversationA.id, rawQuery: {} });
    const resultB = await service.getMessages({ tenantId: 'acme', matchedScope: 'public', conversationId: conversationB.id, rawQuery: {} });
    expect(resultA.kind).toBe('success');
    expect(resultB.kind).toBe('success');
    if (resultA.kind !== 'success' || resultB.kind !== 'success') return;

    // Both conversations have messageCount 0 (neither ever called incrementMessageCount) - if
    // the ETag were derived from messageCount ALONE, these would collide.
    expect(resultA.etag).not.toBe(resultB.etag);

    // And reusing conversation A's own ETag as If-None-Match against conversation B must NEVER
    // short-circuit to not_modified - they are different resources, even at equal messageCount.
    const crossConversationAttempt = await service.getMessages({
      tenantId: 'acme',
      matchedScope: 'public',
      conversationId: conversationB.id,
      rawQuery: {},
      ifNoneMatch: resultA.etag,
    });
    expect(crossConversationAttempt.kind).toBe('success');
  });

  it("Part 0, item Q2 - tenant/ownership checks run BEFORE any 304 decision: a mismatched or nonexistent id is ALWAYS the 404, " +
    'never a 304, however the If-None-Match header is forged', async () => {
    const { service, conversationRepository } = makeService();
    const ownedConversation = await conversationRepository.create('acme', 'cust_owner');
    // The attacker cannot know a real ETag for a conversation they don't own, but the whole
    // point of this guarantee is that it must not matter even if they somehow guessed or forged
    // one that happens to look plausible - ownership is checked first, unconditionally.
    const forgedGuesses = [`W/"${ownedConversation.id}-0"`, '"anything"', 'W/"0"', ownedConversation.id];

    for (const guess of forgedGuesses) {
      // Case 1: right tenant, no/anonymous identity, but the conversation belongs to cust_owner.
      const mismatchResult = await service.getMessages({
        tenantId: 'acme',
        matchedScope: 'public',
        conversationId: ownedConversation.id,
        rawQuery: {},
        ifNoneMatch: guess,
      });
      expect(mismatchResult).toMatchObject({ kind: 'error', code: 'NOT_FOUND' });

      // Case 2: a conversation id that was never created at all.
      const nonexistentResult = await service.getMessages({
        tenantId: 'acme',
        matchedScope: 'public',
        conversationId: 'doesNotExistAtAll98765',
        rawQuery: {},
        ifNoneMatch: guess,
      });
      expect(nonexistentResult).toMatchObject({ kind: 'error', code: 'NOT_FOUND' });
    }
  });
});
