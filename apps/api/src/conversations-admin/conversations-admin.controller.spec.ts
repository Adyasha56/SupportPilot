import { afterEach, describe, expect, it } from 'vitest';
import { INestApplication } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AdminAuthGuard } from '../admin-auth/admin-auth.guard';
import { AdminAuthSettings } from '../admin-auth/admin-auth.settings';
import { ADMIN_AUTH_SETTINGS } from '../admin-auth/admin-auth-settings.provider';
import { PRODUCTION_SESSION_COOKIE_NAME } from '../admin-auth/cookie-utils';
import { hashSessionToken, mintCsrfToken, mintSessionToken } from '../admin-auth/session-token';
import { generateRawApiKey, getKeyPrefix, hashApiKey } from '../auth/api-key.service';
import { API_KEY_REPOSITORY } from '../db/api-key.repository';
import { ADMIN_SESSION_REPOSITORY } from '../db/admin-session.repository';
import { AGENT_RUN_REPOSITORY } from '../db/agent-run.repository';
import { CONVERSATION_REPOSITORY } from '../db/conversation.repository';
import { MESSAGE_REPOSITORY } from '../db/message.repository';
import { POLICY_CHUNK_REPOSITORY } from '../db/policy-chunk.repository';
import { InMemoryApiKeyRepository } from '../db/test-utils/in-memory-api-key.repository';
import { InMemoryAdminSessionRepository } from '../db/test-utils/in-memory-admin-session.repository';
import { InMemoryAgentRunRepository } from '../db/test-utils/in-memory-agent-run.repository';
import { InMemoryConversationRepository } from '../db/test-utils/in-memory-conversation.repository';
import { InMemoryMessageRepository } from '../db/test-utils/in-memory-message.repository';
import { InMemoryPolicyChunkRepository } from '../db/test-utils/in-memory-policy-chunk.repository';
import { ConversationsAdminController } from './conversations-admin.controller';
import { ConversationsAdminService } from './conversations-admin.service';

function adminAuthSettings(overrides: Partial<AdminAuthSettings> = {}): AdminAuthSettings {
  return {
    hashMaxConcurrency: 6,
    hashMaxQueueLength: 20,
    sessionAbsoluteLifetimeMs: 8 * 60 * 60 * 1000,
    sessionIdleTimeoutMs: 30 * 60 * 1000,
    sessionLastSeenWriteIntervalMs: 60_000,
    lockoutFreeAttempts: 3,
    lockoutBaseMs: 1_000,
    lockoutCapMs: 15 * 60 * 1000,
    loginIpRateLimitMaxRequests: 1000,
    loginIpRateLimitWindowMs: 60_000,
    loginIpRateLimitMaxEntries: 1000,
    devCookieEnabled: false,
    allowedOrigins: ['https://admin.supportpilot.example'],
    principalRateLimitMaxRequests: 1000,
    principalRateLimitWindowMs: 60_000,
    principalRateLimitMaxEntries: 1000,
    ...overrides,
  };
}

async function buildApp() {
  const apiKeyRepository = new InMemoryApiKeyRepository();
  const sessionRepository = new InMemoryAdminSessionRepository();
  const conversationRepository = new InMemoryConversationRepository();
  const messageRepository = new InMemoryMessageRepository();
  const agentRunRepository = new InMemoryAgentRunRepository();
  const policyChunkRepository = new InMemoryPolicyChunkRepository();

  const moduleRef = await Test.createTestingModule({
    controllers: [ConversationsAdminController],
    providers: [
      ConversationsAdminService,
      AdminAuthGuard,
      Reflector,
      { provide: API_KEY_REPOSITORY, useValue: apiKeyRepository },
      { provide: ADMIN_SESSION_REPOSITORY, useValue: sessionRepository },
      { provide: ADMIN_AUTH_SETTINGS, useValue: adminAuthSettings() },
      { provide: CONVERSATION_REPOSITORY, useValue: conversationRepository },
      { provide: MESSAGE_REPOSITORY, useValue: messageRepository },
      { provide: AGENT_RUN_REPOSITORY, useValue: agentRunRepository },
      { provide: POLICY_CHUNK_REPOSITORY, useValue: policyChunkRepository },
    ],
  }).compile();

  const app = moduleRef.createNestApplication();
  await app.init();

  async function createKey(tenantId: string, scope: 'public' | 'secret' | 'admin' = 'admin') {
    const rawKey = generateRawApiKey();
    await apiKeyRepository.create(tenantId, hashApiKey(rawKey), getKeyPrefix(rawKey), [scope]);
    return rawKey;
  }

  async function createSession(tenantId: string) {
    const rawSessionToken = mintSessionToken();
    await sessionRepository.create({
      tenantId,
      principalId: tenantId,
      tokenHash: hashSessionToken(rawSessionToken),
      csrfToken: mintCsrfToken(),
      lastSeenAt: new Date(),
      absoluteExpiresAt: new Date(Date.now() + 100_000),
      idleTimeoutMs: 100_000,
    });
    return `${PRODUCTION_SESSION_COOKIE_NAME}=${rawSessionToken}`;
  }

  return { app, conversationRepository, messageRepository, agentRunRepository, policyChunkRepository, createKey, createSession };
}

describe('ConversationsAdminController (Stage 1c, item 2)', () => {
  let app: INestApplication | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  describe('GET /v1/conversations', () => {
    it('lists only the calling tenant\'s conversations, with an ADMIN-scoped key', async () => {
      const built = await buildApp();
      app = built.app;
      await built.conversationRepository.create('acme', 'cust_1');
      await built.conversationRepository.create('widgetco', 'cust_1');
      const rawKey = await built.createKey('acme');

      const res = await request(app.getHttpServer()).get('/v1/conversations').set('Authorization', `Bearer ${rawKey}`);

      expect(res.status).toBe(200);
      expect(res.body.conversations).toHaveLength(1);
    });

    it('a SECRET-scoped key (not admin) is rejected - admin is required here, unlike policies', async () => {
      const built = await buildApp();
      app = built.app;
      const rawKey = await built.createKey('acme', 'secret');

      const res = await request(app.getHttpServer()).get('/v1/conversations').set('Authorization', `Bearer ${rawKey}`);
      expect(res.status).toBe(401);
    });

    it('a cookie-authenticated admin session can list with no API key at all', async () => {
      const built = await buildApp();
      app = built.app;
      await built.conversationRepository.create('acme', 'cust_1');
      const cookie = await built.createSession('acme');

      const res = await request(app.getHttpServer()).get('/v1/conversations').set('Cookie', cookie);
      expect(res.status).toBe(200);
      expect(res.body.conversations).toHaveLength(1);
    });

    it('rejects an invalid query (a malformed status value)', async () => {
      const built = await buildApp();
      app = built.app;
      const rawKey = await built.createKey('acme');

      const res = await request(app.getHttpServer()).get('/v1/conversations?status=not-a-real-status').set('Authorization', `Bearer ${rawKey}`);
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('INVALID_REQUEST');
    });

    it('cursor-paginates with a stable nextCursor', async () => {
      const built = await buildApp();
      app = built.app;
      for (let i = 0; i < 3; i++) {
        await built.conversationRepository.create('acme', `cust_${i}`);
        await new Promise((r) => setTimeout(r, 2));
      }
      const rawKey = await built.createKey('acme');

      const first = await request(app.getHttpServer()).get('/v1/conversations?limit=2').set('Authorization', `Bearer ${rawKey}`);
      expect(first.body.conversations).toHaveLength(2);
      expect(first.body.nextCursor).toBeDefined();

      const second = await request(app.getHttpServer())
        .get(`/v1/conversations?limit=2&cursor=${encodeURIComponent(first.body.nextCursor)}`)
        .set('Authorization', `Bearer ${rawKey}`);
      expect(second.body.conversations).toHaveLength(1);
      expect(second.body.nextCursor).toBeUndefined();
    });

    it('returns 503 when the database is not configured', async () => {
      const moduleRef = await Test.createTestingModule({
        controllers: [ConversationsAdminController],
        providers: [
          ConversationsAdminService,
          AdminAuthGuard,
          Reflector,
          { provide: API_KEY_REPOSITORY, useValue: new InMemoryApiKeyRepository() },
          { provide: ADMIN_SESSION_REPOSITORY, useValue: new InMemoryAdminSessionRepository() },
          { provide: ADMIN_AUTH_SETTINGS, useValue: adminAuthSettings() },
          // CONVERSATION_REPOSITORY / MESSAGE_REPOSITORY / AGENT_RUN_REPOSITORY deliberately omitted.
        ],
      }).compile();
      app = moduleRef.createNestApplication();
      await app.init();

      const apiKeyRepository = moduleRef.get(API_KEY_REPOSITORY);
      const rawKey = generateRawApiKey();
      await apiKeyRepository.create('acme', hashApiKey(rawKey), getKeyPrefix(rawKey), ['admin']);

      const res = await request(app.getHttpServer()).get('/v1/conversations').set('Authorization', `Bearer ${rawKey}`);
      expect(res.status).toBe(503);
      expect(res.body.code).toBe('NOT_CONFIGURED');
    });
  });

  describe('GET /v1/conversations/:id', () => {
    it("returns the identical 404 for another tenant's conversation id and a nonexistent one", async () => {
      const built = await buildApp();
      app = built.app;
      const acmeConvo = await built.conversationRepository.create('acme', 'cust_1');
      const rawKey = await built.createKey('widgetco');

      const notFoundForOther = await request(app.getHttpServer()).get(`/v1/conversations/${acmeConvo.id}`).set('Authorization', `Bearer ${rawKey}`);
      const notFoundForMissing = await request(app.getHttpServer())
        .get('/v1/conversations/totally-made-up-id')
        .set('Authorization', `Bearer ${rawKey}`);

      expect(notFoundForOther.status).toBe(404);
      expect(notFoundForMissing.status).toBe(404);
      expect(notFoundForOther.body).toEqual(notFoundForMissing.body);
    });

    it('returns customerRef IN FULL, the full message transcript, and every AgentRun for the conversation', async () => {
      const built = await buildApp();
      app = built.app;
      const convo = await built.conversationRepository.create('acme', 'cust_full_ref_12345');
      await built.messageRepository.create('acme', convo.id, 'customer', 'where is my order');
      await built.messageRepository.create('acme', convo.id, 'agent', 'let me check');
      await built.agentRunRepository.create({
        tenantId: 'acme',
        runId: 'r_1',
        conversationId: convo.id,
        outcome: 'reply',
        stepCount: 2,
        llmCallCount: 2,
        tokensIn: 10,
        tokensOut: 20,
        latencyMs: 100,
        steps: [{ type: 'plan', durationMs: 5, outcomeCode: 'OK' }],
      });
      const rawKey = await built.createKey('acme');

      const res = await request(app.getHttpServer()).get(`/v1/conversations/${convo.id}`).set('Authorization', `Bearer ${rawKey}`);

      expect(res.status).toBe(200);
      expect(res.body.customerRef).toBe('cust_full_ref_12345');
      expect(res.body.messages.map((m: { content: string }) => m.content)).toEqual(['where is my order', 'let me check']);
      expect(res.body.runs).toHaveLength(1);
      expect(res.body.runs[0]).toMatchObject({ runId: 'r_1', outcome: 'reply', llmCallCount: 2 });
    });

    it('resolves a cited chunkKey to its current headingPath/documentTitle', async () => {
      const built = await buildApp();
      app = built.app;
      const convo = await built.conversationRepository.create('acme', 'cust_1');
      await built.policyChunkRepository.insertMany([
        {
          tenantId: 'acme',
          documentId: 'doc-1',
          title: 'Refund Policy',
          headingPath: 'Refund Policy > Late Delivery',
          position: 3,
          text: 'text',
          embedding: [1, 0, 0],
          embeddingModel: 'fake',
          embeddingDimension: 3,
          contentHash: 'hash-1',
        },
      ]);
      await built.agentRunRepository.create({
        tenantId: 'acme',
        runId: 'r_1',
        conversationId: convo.id,
        outcome: 'reply',
        stepCount: 1,
        llmCallCount: 1,
        tokensIn: 0,
        tokensOut: 0,
        latencyMs: 0,
        steps: [{ type: 'compose', durationMs: 1, outcomeCode: 'OK', citedChunkKeys: ['doc-1-3'] }],
      });
      const rawKey = await built.createKey('acme');

      const res = await request(app.getHttpServer()).get(`/v1/conversations/${convo.id}`).set('Authorization', `Bearer ${rawKey}`);

      expect(res.body.runs[0].steps[0].citations).toEqual([
        { chunkKey: 'doc-1-3', headingPath: 'Refund Policy > Late Delivery', documentTitle: 'Refund Policy' },
      ]);
    });

    it('a cited chunkKey for a document deleted since the run - the bare key is still shown, with no headingPath, never an error', async () => {
      const built = await buildApp();
      app = built.app;
      const convo = await built.conversationRepository.create('acme', 'cust_1');
      await built.agentRunRepository.create({
        tenantId: 'acme',
        runId: 'r_1',
        conversationId: convo.id,
        outcome: 'reply',
        stepCount: 1,
        llmCallCount: 1,
        tokensIn: 0,
        tokensOut: 0,
        latencyMs: 0,
        steps: [{ type: 'compose', durationMs: 1, outcomeCode: 'OK', citedChunkKeys: ['deleted-doc-0'] }],
      });
      const rawKey = await built.createKey('acme');

      const res = await request(app.getHttpServer()).get(`/v1/conversations/${convo.id}`).set('Authorization', `Bearer ${rawKey}`);

      expect(res.status).toBe(200);
      expect(res.body.runs[0].steps[0].citations).toEqual([{ chunkKey: 'deleted-doc-0' }]);
    });

    it('never includes raw tool response bodies or prompt text - only ids/codes/counts/durations', async () => {
      const built = await buildApp();
      app = built.app;
      const convo = await built.conversationRepository.create('acme', 'cust_1');
      await built.agentRunRepository.create({
        tenantId: 'acme',
        runId: 'r_1',
        conversationId: convo.id,
        outcome: 'reply',
        stepCount: 1,
        llmCallCount: 1,
        tokensIn: 0,
        tokensOut: 0,
        latencyMs: 0,
        steps: [{ type: 'tool', durationMs: 1, outcomeCode: 'OK', toolName: 'get_order', orderId: 'ORD-1001' }],
      });
      const rawKey = await built.createKey('acme');

      const res = await request(app.getHttpServer()).get(`/v1/conversations/${convo.id}`).set('Authorization', `Bearer ${rawKey}`);

      const bodyText = JSON.stringify(res.body);
      expect(bodyText).toContain('ORD-1001'); // the order id itself is fine
      expect(bodyText).not.toContain('prompt');
      expect(res.body.runs[0].steps[0]).toEqual({ type: 'tool', durationMs: 1, outcomeCode: 'OK', toolName: 'get_order', orderId: 'ORD-1001' });
    });
  });
});
