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
    ...overrides,
  };
}

function makeService(opts: {
  conversationRepository?: InMemoryConversationRepository;
  messageRepository?: InMemoryMessageRepository;
  customerPublicKeyRepository?: InMemoryCustomerPublicKeyRepository;
  settings?: Partial<ChatSettings>;
  pollRateLimiter?: RateLimiter;
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

  const service = new ConversationMessagesService(conversationRepository, messageRepository, customerPublicKeyRepository, settings, pollRateLimiter);
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
    const service = new ConversationMessagesService(undefined, undefined, undefined, settings, pollRateLimiter);

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
});
