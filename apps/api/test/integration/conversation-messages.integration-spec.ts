/**
 * Milestone 5, Stage 1a, amendment A6 - GET /v1/chat/conversations/:id/messages,
 * through the REAL AppModule (real ApiKeyGuard, real Mongoose repositories,
 * the real {tenantId,conversationId,createdAt} index) with only
 * LLM_PROVIDER faked (app-harness.ts's bootApp - this endpoint never calls
 * the LLM at all, but AppModule still needs a resolvable LLM_PROVIDER).
 * Conversations/messages are seeded directly via the real repositories
 * (same technique chat-limits.integration-spec.ts's own "conversation
 * length cap" test uses), not via POST /v1/chat - this suite's whole point
 * is the READ endpoint's ownership/isolation/pagination behavior, not the
 * agent loop.
 */
import './test-env';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { bootApp } from './app-harness';
import { cleanupTenant, createTenantFixture, disconnectFixtureConnection, TenantFixture } from './tenant-fixture';
import { mintCustomerToken, registerCustomerKeyFixture } from './chat-fixtures';
import { getTestMongoUri, integrationTestsEnabled } from './test-env';
import { CONVERSATION_REPOSITORY, ConversationRepository } from '../../src/db/conversation.repository';
import { MESSAGE_REPOSITORY, MessageRepository } from '../../src/db/message.repository';
import type { AppHarness } from './app-harness';

const uri = integrationTestsEnabled() ? getTestMongoUri() : '';
const allCreatedTenants: string[] = [];

async function newTenant(): Promise<TenantFixture> {
  const fixture = await createTenantFixture(uri);
  allCreatedTenants.push(fixture.tenantId);
  return fixture;
}

afterAll(async () => {
  if (!integrationTestsEnabled()) {
    return;
  }
  await Promise.all(allCreatedTenants.map((tenantId) => cleanupTenant(uri, tenantId)));
  await disconnectFixtureConnection();
});

describe.skipIf(!integrationTestsEnabled())('GET /v1/chat/conversations/:id/messages (integration, real database)', () => {
  let h: AppHarness;
  let conversationRepository: ConversationRepository;
  let messageRepository: MessageRepository;

  beforeAll(async () => {
    h = await bootApp();
    conversationRepository = h.app.get(CONVERSATION_REPOSITORY);
    messageRepository = h.app.get(MESSAGE_REPOSITORY);
  }, 60_000);
  afterAll(() => h.close());

  it('an anonymous caller reads an anonymous conversation, oldest first, role/content/createdAt only', async () => {
    const tenant = await newTenant();
    const conversation = await conversationRepository.create(tenant.tenantId, null);
    await messageRepository.create(tenant.tenantId, conversation.id, 'customer', 'where is my order');
    await messageRepository.create(tenant.tenantId, conversation.id, 'agent', 'let me check');

    const res = await request(h.app.getHttpServer()).get(`/v1/chat/conversations/${conversation.id}/messages`).set('Authorization', `Bearer ${tenant.publicKey}`);

    expect(res.status).toBe(200);
    expect(res.body.messages).toEqual([
      { role: 'customer', content: 'where is my order', createdAt: expect.any(String) },
      { role: 'agent', content: 'let me check', createdAt: expect.any(String) },
    ]);
    expect(Object.keys(res.body.messages[0]).sort()).toEqual(['content', 'createdAt', 'role']);
    expect(res.body.nextCursor).toBeTypeOf('string');
  });

  it('an identified caller reads their own conversation via a verified customerToken', async () => {
    const tenant = await newTenant();
    const { kid, privateKey } = await registerCustomerKeyFixture(uri, tenant.tenantId);
    const token = mintCustomerToken(tenant.tenantId, 'cust_owner', kid, privateKey);
    const conversation = await conversationRepository.create(tenant.tenantId, 'cust_owner');
    await messageRepository.create(tenant.tenantId, conversation.id, 'customer', 'hi');

    const res = await request(h.app.getHttpServer())
      .get(`/v1/chat/conversations/${conversation.id}/messages`)
      .query({ customerToken: token })
      .set('Authorization', `Bearer ${tenant.publicKey}`);

    expect(res.status).toBe(200);
    expect(res.body.messages).toHaveLength(1);
  });

  it("a different customer's verified token gets the SAME 404 as a nonexistent id - never a leak", async () => {
    const tenant = await newTenant();
    const { kid, privateKey } = await registerCustomerKeyFixture(uri, tenant.tenantId);
    const ownerConversation = await conversationRepository.create(tenant.tenantId, 'cust_owner');
    await messageRepository.create(tenant.tenantId, ownerConversation.id, 'customer', 'owner only content');
    const attackerToken = mintCustomerToken(tenant.tenantId, 'cust_attacker', kid, privateKey);

    const attackerRes = await request(h.app.getHttpServer())
      .get(`/v1/chat/conversations/${ownerConversation.id}/messages`)
      .query({ customerToken: attackerToken })
      .set('Authorization', `Bearer ${tenant.publicKey}`);
    const nonexistentRes = await request(h.app.getHttpServer())
      .get('/v1/chat/conversations/doesNotExistAtAll12345/messages')
      .query({ customerToken: attackerToken })
      .set('Authorization', `Bearer ${tenant.publicKey}`);

    expect(attackerRes.status).toBe(404);
    expect(nonexistentRes.status).toBe(404);
    expect(attackerRes.body).toEqual(nonexistentRes.body);
    expect(JSON.stringify(attackerRes.body)).not.toContain('owner only content');
  });

  it('tenant isolation: tenant B can never read tenant A\'s conversation, even with the identical id reused', async () => {
    const tenantA = await newTenant();
    const tenantB = await newTenant();
    const conversation = await conversationRepository.create(tenantA.tenantId, null);
    await messageRepository.create(tenantA.tenantId, conversation.id, 'customer', 'tenant A secret');

    const res = await request(h.app.getHttpServer())
      .get(`/v1/chat/conversations/${conversation.id}/messages`)
      .set('Authorization', `Bearer ${tenantB.publicKey}`);

    expect(res.status).toBe(404);
  });

  it('a secret-scope key may assert customerRef directly and read that customer\'s conversation', async () => {
    const tenant = await newTenant();
    const conversation = await conversationRepository.create(tenant.tenantId, 'cust_trusted');
    await messageRepository.create(tenant.tenantId, conversation.id, 'customer', 'via secret key');

    const res = await request(h.app.getHttpServer())
      .get(`/v1/chat/conversations/${conversation.id}/messages`)
      .query({ customerRef: 'cust_trusted' })
      .set('Authorization', `Bearer ${tenant.secretKey}`);

    expect(res.status).toBe(200);
    expect(res.body.messages).toHaveLength(1);
  });

  it('a present-but-invalid customer token is a uniform 401, never collapsed into anonymous', async () => {
    const tenant = await newTenant();
    const conversation = await conversationRepository.create(tenant.tenantId, null);

    const res = await request(h.app.getHttpServer())
      .get(`/v1/chat/conversations/${conversation.id}/messages`)
      .query({ customerToken: 'garbage-not-a-real-token' })
      .set('Authorization', `Bearer ${tenant.publicKey}`);

    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ code: 'INVALID_CUSTOMER_TOKEN' });
  });

  it('cursor pagination against the real index: a second poll with the first call\'s nextCursor returns only the newer messages', async () => {
    const tenant = await newTenant();
    const conversation = await conversationRepository.create(tenant.tenantId, null);
    await messageRepository.create(tenant.tenantId, conversation.id, 'customer', 'first');

    const firstRes = await request(h.app.getHttpServer())
      .get(`/v1/chat/conversations/${conversation.id}/messages`)
      .set('Authorization', `Bearer ${tenant.publicKey}`);
    expect(firstRes.body.messages.map((m: { content: string }) => m.content)).toEqual(['first']);

    await messageRepository.create(tenant.tenantId, conversation.id, 'agent', 'second');

    const secondRes = await request(h.app.getHttpServer())
      .get(`/v1/chat/conversations/${conversation.id}/messages`)
      .query({ after: firstRes.body.nextCursor })
      .set('Authorization', `Bearer ${tenant.publicKey}`);
    expect(secondRes.body.messages.map((m: { content: string }) => m.content)).toEqual(['second']);
  });
});
