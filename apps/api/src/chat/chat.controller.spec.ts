import * as http from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { INestApplication } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { PlannerOutput, ComposeOutput } from '@supportpilot/shared';
import { ApiKeyGuard } from '../auth/api-key.guard';
import { generateRawApiKey, getKeyPrefix, hashApiKey } from '../auth/api-key.service';
import { API_KEY_REPOSITORY } from '../db/api-key.repository';
import { TENANT_REPOSITORY } from '../db/tenant.repository';
import { InMemoryApiKeyRepository } from '../db/test-utils/in-memory-api-key.repository';
import { InMemoryTenantRepository } from '../db/test-utils/in-memory-tenant.repository';
import { CONVERSATION_REPOSITORY } from '../db/conversation.repository';
import { MESSAGE_REPOSITORY } from '../db/message.repository';
import { AGENT_RUN_REPOSITORY } from '../db/agent-run.repository';
import { CUSTOMER_PUBLIC_KEY_REPOSITORY } from '../db/customer-public-key.repository';
import { InMemoryConversationRepository } from '../db/test-utils/in-memory-conversation.repository';
import { InMemoryMessageRepository } from '../db/test-utils/in-memory-message.repository';
import { InMemoryAgentRunRepository } from '../db/test-utils/in-memory-agent-run.repository';
import { InMemoryCustomerPublicKeyRepository } from '../db/test-utils/in-memory-customer-public-key.repository';
import { LLM_PROVIDER } from '../llm/llm.module';
import { FakeLlmProvider } from '../llm/test-utils/fake-llm-provider';
import { GenerateOutcome } from '../llm/llm-provider.interface';
import { PolicyRetrievalService } from '../retrieval/policy-retrieval.service';
import { CONNECTOR_CONFIG_REPOSITORY } from '../connectors/connector-config-repository.provider';
import { DisabledConnectorConfigRepository } from '../connectors/connector-config.repository';
import { TOOL_RUNNER_SETTINGS } from '../agent/tool-runner/tool-runner-settings.provider';
import { API_KEY_GUARD_SETTINGS } from '../auth/api-key.guard';
import { CHAT_SETTINGS } from './chat-settings.provider';
import { RUN_AGENT_SETTINGS } from './run-agent-settings.provider';
import { DAILY_GENERATE_BUDGET, TENANT_GENERATE_BUDGET } from './budget-guards.provider';
import { READ_ONLY_TOOL_RUNNER } from './read-only-tool-runner.provider';
import { TENANT_RATE_LIMITER, CUSTOMER_REF_RATE_LIMITER } from './rate-limiters.provider';
import { CONVERSATION_LOCK } from './conversation-lock.provider';
import { IN_FLIGHT_RUN_LIMITER } from './in-flight-run-limiter.provider';
import { RateLimiter } from '../auth/rate-limiter';
import { ConversationLock } from './conversation-lock';
import { InFlightRunLimiter } from './in-flight-run-limiter';
import { ChatBodyParserErrorFilter } from './chat-body-parser-error.filter';
import { ChatController } from './chat.controller';
import { ChatRetryAfterFilter } from './chat-retry-after.filter';
import { ChatService } from './chat.service';

function planOutput(overrides: Partial<PlannerOutput> = {}): GenerateOutcome {
  const data: PlannerOutput = { reasoning: 'thinking', needsPolicy: false, toolRequests: [], ...overrides };
  return { ok: true, result: { text: JSON.stringify(data), usage: { inputTokens: 10, outputTokens: 10 } } };
}

function composeOutput(overrides: Partial<ComposeOutput> = {}): GenerateOutcome {
  const data: ComposeOutput = { outcome: 'clarify', message: 'which order?', citedChunkKeys: [], ...overrides };
  return { ok: true, result: { text: JSON.stringify(data), usage: { inputTokens: 10, outputTokens: 10 } } };
}

interface BuildAppOptions {
  generateQueue?: GenerateOutcome[];
  maxBodyBytes?: number;
  omitDatabase?: boolean;
  inFlightMaxRuns?: number;
  inFlightMaxQueued?: number;
}

async function buildApp(options: BuildAppOptions = {}) {
  const apiKeyRepository = new InMemoryApiKeyRepository();
  const tenantRepository = new InMemoryTenantRepository();
  const conversationRepository = options.omitDatabase ? undefined : new InMemoryConversationRepository();
  const messageRepository = options.omitDatabase ? undefined : new InMemoryMessageRepository();
  const agentRunRepository = options.omitDatabase ? undefined : new InMemoryAgentRunRepository();
  const customerPublicKeyRepository = options.omitDatabase ? undefined : new InMemoryCustomerPublicKeyRepository();
  const llm = new FakeLlmProvider(options.generateQueue ?? [planOutput(), composeOutput()]);

  const moduleRef = await Test.createTestingModule({
    controllers: [ChatController],
    providers: [
      ApiKeyGuard,
      Reflector,
      ChatService,
      ChatRetryAfterFilter,
      { provide: API_KEY_REPOSITORY, useValue: apiKeyRepository },
      { provide: TENANT_REPOSITORY, useValue: tenantRepository },
      { provide: API_KEY_GUARD_SETTINGS, useValue: { ipRateLimit: { maxRequests: 1000, windowMs: 60_000, maxEntries: 1000 }, keyRateLimit: { maxRequests: 1000, windowMs: 60_000, maxEntries: 1000 } } },
      { provide: CONVERSATION_REPOSITORY, useValue: conversationRepository },
      { provide: MESSAGE_REPOSITORY, useValue: messageRepository },
      { provide: AGENT_RUN_REPOSITORY, useValue: agentRunRepository },
      { provide: CUSTOMER_PUBLIC_KEY_REPOSITORY, useValue: customerPublicKeyRepository },
      { provide: LLM_PROVIDER, useValue: llm },
      { provide: PolicyRetrievalService, useValue: { retrieve: async () => ({ ok: true, results: [] }) } },
      { provide: CONNECTOR_CONFIG_REPOSITORY, useValue: new DisabledConnectorConfigRepository() },
      { provide: TOOL_RUNNER_SETTINGS, useValue: { hostAllowlist: [], requestTimeoutMs: 5000, maxResponseBytes: 100_000, allowPrivateNetworks: false, requireHttps: false } },
      { provide: READ_ONLY_TOOL_RUNNER, useValue: { run: async () => ({ ok: false, error: { code: 'CONFIG_ERROR', message: 'no tools in this test' } }) } },
      {
        provide: CHAT_SETTINGS,
        useValue: {
          historyWindowSize: 10,
          historyMaxChars: 6000,
          maxMessagesPerConversation: 50,
          maxBodyBytes: options.maxBodyBytes ?? 32_000,
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
          inFlightMaxRuns: options.inFlightMaxRuns ?? 3,
          inFlightMaxQueued: options.inFlightMaxQueued ?? 2,
          inFlightRetryAfterSeconds: 5,
          conversationLockTtlMs: 35_000,
          conversationLockMaxEntries: 1000,
          httpDeadlineMs: 35_000,
          retentionDays: 30,
          maxActiveCustomerKeysPerTenant: 5,
          tenantDailyGenerateBudget: 50,
        },
      },
      {
        provide: RUN_AGENT_SETTINGS,
        useValue: { perLlmCallTimeoutMs: 8000, totalDeadlineMs: 25000, retrievalTimeoutMs: 5000, timeoutMaxRetries: 2, generateMaxOutputTokens: 1024, generateTemperature: 0 },
      },
      { provide: DAILY_GENERATE_BUDGET, useValue: { tryConsume: () => true, release: () => {} } },
      { provide: TENANT_GENERATE_BUDGET, useValue: { tryConsume: () => true, release: () => {} } },
      { provide: TENANT_RATE_LIMITER, useValue: new RateLimiter({ maxRequests: 1000, windowMs: 60_000, maxEntries: 1000 }, () => new Date()) },
      { provide: CUSTOMER_REF_RATE_LIMITER, useValue: new RateLimiter({ maxRequests: 1000, windowMs: 60_000, maxEntries: 1000 }, () => new Date()) },
      { provide: CONVERSATION_LOCK, useValue: new ConversationLock({ ttlMs: 35_000, maxEntries: 1000 }, () => new Date()) },
      { provide: IN_FLIGHT_RUN_LIMITER, useValue: new InFlightRunLimiter({ maxInFlight: options.inFlightMaxRuns ?? 3, maxQueued: options.inFlightMaxQueued ?? 2, retryAfterSeconds: 5 }) },
    ],
  }).compile();

  const app: INestApplication = moduleRef.createNestApplication();
  // Same global registration main.ts does for real - a body that fails to
  // parse at all (too large, malformed JSON) never reaches ChatController
  // or any controller-scoped filter at all; see that filter's own doc
  // comment for the empirical confirmation this is based on.
  app.useGlobalFilters(new ChatBodyParserErrorFilter(app.getHttpAdapter()));
  await app.init();

  async function createKey(tenantId: string, scope: 'public' | 'secret' = 'secret') {
    const rawKey = generateRawApiKey();
    const hash = hashApiKey(rawKey);
    await apiKeyRepository.create(tenantId, hash, getKeyPrefix(rawKey), [scope]);
    return rawKey;
  }

  return { app, createKey, apiKeyRepository };
}

describe('ChatController (e2e, in-memory repositories, FakeLlmProvider)', () => {
  let app: INestApplication | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it('a secret-scope key gets a full 200 ChatResult', async () => {
    const built = await buildApp();
    app = built.app;
    const key = await built.createKey('acme', 'secret');

    const res = await request(app.getHttpServer()).post('/v1/chat').set('Authorization', `Bearer ${key}`).send({ message: 'where is my order' });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ outcome: 'clarify', message: 'which order?' });
    expect(typeof res.body.conversationId).toBe('string');
    expect(typeof res.body.runId).toBe('string');
  });

  it('a public-scope key (the widget) also gets a 200, anonymously', async () => {
    const built = await buildApp();
    app = built.app;
    const key = await built.createKey('acme', 'public');

    const res = await request(app.getHttpServer()).post('/v1/chat').set('Authorization', `Bearer ${key}`).send({ message: 'hi there' });

    expect(res.status).toBe(200);
  });

  it('413 REQUEST_TOO_LARGE in the project shape, never the default body-parser shape', async () => {
    const built = await buildApp({ maxBodyBytes: 100 });
    app = built.app;
    const key = await built.createKey('acme', 'secret');

    const res = await request(app.getHttpServer())
      .post('/v1/chat')
      .set('Authorization', `Bearer ${key}`)
      .send({ message: 'x'.repeat(500) });

    expect(res.status).toBe(413);
    expect(res.body).toMatchObject({ statusCode: 413, code: 'REQUEST_TOO_LARGE' });
    expect(res.body).not.toHaveProperty('error'); // the default body-parser/Express shape has {statusCode, message, error} - never our "code" field
  });

  it('a body over Express\'s own global default parser limit (100KB) still gets the project shape, via the global filter, before ChatController\'s own check ever runs', async () => {
    // Deliberately uses the DEFAULT maxBodyBytes (32000, well under 100KB) -
    // the point is that a body this large never even reaches ChatController's
    // own enforceBodySize check (body-parsing fails first, at the Nest/Express
    // middleware layer), so without ChatBodyParserErrorFilter this would come
    // back in Express's own {statusCode, message} shape instead.
    const built = await buildApp();
    app = built.app;
    const key = await built.createKey('acme', 'secret');

    const res = await request(app.getHttpServer())
      .post('/v1/chat')
      .set('Authorization', `Bearer ${key}`)
      .send({ message: 'x'.repeat(200_000) });

    expect(res.status).toBe(413);
    expect(res.body).toEqual({ statusCode: 413, code: 'REQUEST_TOO_LARGE', message: 'Request body exceeds the configured byte limit.' });
  });

  it('malformed JSON gets the project\'s 400 INVALID_REQUEST shape, not Nest\'s default BadRequestException shape', async () => {
    const built = await buildApp();
    app = built.app;
    const key = await built.createKey('acme', 'secret');

    const res = await request(app.getHttpServer())
      .post('/v1/chat')
      .set('Authorization', `Bearer ${key}`)
      .set('Content-Type', 'application/json')
      .send('{not valid json');

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ statusCode: 400, code: 'INVALID_REQUEST', message: 'The request body is invalid.' });
  });

  it('a wrong Content-Type (body never parsed as JSON at all) still gets 400 INVALID_REQUEST via ChatRequestSchema validation', async () => {
    const built = await buildApp();
    app = built.app;
    const key = await built.createKey('acme', 'secret');

    const res = await request(app.getHttpServer())
      .post('/v1/chat')
      .set('Authorization', `Bearer ${key}`)
      .set('Content-Type', 'text/plain')
      .send('{"message":"hi"}');

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ statusCode: 400, code: 'INVALID_REQUEST' });
  });

  it('a chunked body with no Content-Length header, exceeding the limit, still gets the project 413 shape', async () => {
    const built = await buildApp();
    app = built.app;
    const key = await built.createKey('acme', 'secret');
    await app.listen(0);
    const address = app.getHttpServer().address();
    const port = typeof address === 'object' && address ? address.port : 0;

    const res = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = http.request(
        { host: '127.0.0.1', port, path: '/v1/chat', method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' } },
        (response) => {
          const chunks: Buffer[] = [];
          response.on('data', (chunk: Buffer) => chunks.push(chunk));
          response.on('end', () => resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }));
        },
      );
      req.on('error', reject);
      // No Content-Length header is ever set - Node's http module sends
      // Transfer-Encoding: chunked automatically whenever a request body is
      // streamed via write()/end() without one.
      req.write(JSON.stringify({ message: 'x'.repeat(200_000) }));
      req.end();
    });

    expect(res.status).toBe(413);
    expect(JSON.parse(res.body)).toEqual({ statusCode: 413, code: 'REQUEST_TOO_LARGE', message: 'Request body exceeds the configured byte limit.' });
  });

  it('a chunked body with no Content-Length header, WITHIN the limit, is handled normally', async () => {
    const built = await buildApp();
    app = built.app;
    const key = await built.createKey('acme', 'secret');
    await app.listen(0);
    const address = app.getHttpServer().address();
    const port = typeof address === 'object' && address ? address.port : 0;

    const res = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = http.request(
        { host: '127.0.0.1', port, path: '/v1/chat', method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' } },
        (response) => {
          const chunks: Buffer[] = [];
          response.on('data', (chunk: Buffer) => chunks.push(chunk));
          response.on('end', () => resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }));
        },
      );
      req.on('error', reject);
      req.write(JSON.stringify({ message: 'hello' }));
      req.end();
    });

    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({ outcome: 'clarify' });
  });

  it('503 NOT_CONFIGURED when the database is unavailable', async () => {
    const built = await buildApp({ omitDatabase: true });
    app = built.app;
    const key = await built.createKey('acme', 'secret');

    const res = await request(app.getHttpServer()).post('/v1/chat').set('Authorization', `Bearer ${key}`).send({ message: 'hi' });

    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({ statusCode: 503, code: 'NOT_CONFIGURED' });
  });

  it('429 BACKPRESSURE sets a real Retry-After header, not just a body field', async () => {
    const built = await buildApp({ inFlightMaxRuns: 0, inFlightMaxQueued: 0 });
    app = built.app;
    const key = await built.createKey('acme', 'secret');

    const res = await request(app.getHttpServer()).post('/v1/chat').set('Authorization', `Bearer ${key}`).send({ message: 'hi' });

    expect(res.status).toBe(429);
    expect(res.body).toMatchObject({ code: 'BACKPRESSURE' });
    expect(res.headers['retry-after']).toBeDefined();
  });

  it('400 INVALID_REQUEST on a missing message field', async () => {
    const built = await buildApp();
    app = built.app;
    const key = await built.createKey('acme', 'secret');

    const res = await request(app.getHttpServer()).post('/v1/chat').set('Authorization', `Bearer ${key}`).send({});

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ statusCode: 400, code: 'INVALID_REQUEST' });
  });
});
