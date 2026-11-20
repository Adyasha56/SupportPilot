import 'reflect-metadata';
import { afterEach, describe, expect, it } from 'vitest';
import { Controller, Get, INestApplication, Module, Post, UseGuards } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { buildCorsOptionsDelegate } from '../src/common/cors';
import { ApiKeyGuard } from '../src/auth/api-key.guard';
import { RequireScope } from '../src/auth/require-scope.decorator';

/**
 * Both fake chat controllers below carry the REAL `ApiKeyGuard` (with NO
 * `ApiKeyRepository` provided - see TestAppModule) - deliberately, so that
 * IF a preflight ever actually reached the guard, it would throw `503
 * NOT_CONFIGURED` (api-key.guard.ts's own "no repository at all" branch)
 * instead of succeeding. Asserting `204` below therefore proves the guard
 * was genuinely never reached for an OPTIONS preflight - not just that this
 * test's fake controller happens to have no guard at all.
 */
@Controller('v1/chat')
@UseGuards(ApiKeyGuard)
@RequireScope('public')
class FakeChatController {
  @Post()
  chat(): { ok: true } {
    return { ok: true };
  }
}

@Controller('v1/chat/conversations')
@UseGuards(ApiKeyGuard)
@RequireScope('public')
class FakeChatSubController {
  @Get(':id/messages')
  messages(): { ok: true } {
    return { ok: true };
  }
}

@Controller('v1/policies')
@UseGuards(ApiKeyGuard)
@RequireScope('secret')
class FakeOtherController {
  @Get()
  list(): { ok: true } {
    return { ok: true };
  }
}

@Module({ controllers: [FakeChatController, FakeChatSubController, FakeOtherController], providers: [ApiKeyGuard] })
class TestAppModule {}

async function bootApp(preflightMaxAgeSeconds = 600): Promise<INestApplication> {
  const app = await NestFactory.create<NestExpressApplication>(TestAppModule, { logger: false });
  app.enableCors(buildCorsOptionsDelegate({ preflightMaxAgeSeconds }));
  await app.init();
  return app;
}

describe('CORS (amendment A5 - any origin, no credentials, only under /v1/chat*)', () => {
  let app: INestApplication | undefined;
  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it('answers a POST /v1/chat preflight before any guard/controller would ever run, with the documented headers', async () => {
    app = await bootApp(600);
    const res = await request(app.getHttpServer())
      .options('/v1/chat')
      .set('Origin', 'https://some-random-embedding-site.example')
      .set('Access-Control-Request-Method', 'POST')
      .set('Access-Control-Request-Headers', 'authorization,content-type');

    expect(res.status).toBe(204);
    expect(res.headers['access-control-allow-origin']).toBe('*');
    expect(res.headers['access-control-allow-credentials']).toBeUndefined();
    expect(res.headers['access-control-allow-methods']).toContain('POST');
    expect(res.headers['access-control-allow-headers']?.toLowerCase()).toContain('authorization');
    expect(res.headers['access-control-expose-headers']).toContain('Retry-After');
    expect(res.headers['access-control-max-age']).toBe('600');
  });

  it('answers a GET /v1/chat/conversations/:id/messages preflight without a key either - the SAME guard-bypass as POST /v1/chat', async () => {
    app = await bootApp();
    const res = await request(app.getHttpServer())
      .options('/v1/chat/conversations/abc/messages')
      .set('Origin', 'https://some-random-embedding-site.example')
      .set('Access-Control-Request-Method', 'GET');

    expect(res.status).toBe(204);
    expect(res.headers['access-control-allow-origin']).toBe('*');
  });

  it(
    'a real (non-preflight) POST /v1/chat request DOES reach the real ApiKeyGuard (503, no repository configured in this test) - ' +
      'yet still carries the permissive, credential-less CORS header regardless, proving CORS and the guard are independent layers',
    async () => {
      app = await bootApp();
      const res = await request(app.getHttpServer()).post('/v1/chat').set('Origin', 'https://embedding-site.example').send({});

      expect(res.status).toBe(503);
      expect(res.headers['access-control-allow-origin']).toBe('*');
      expect(res.headers['access-control-allow-credentials']).toBeUndefined();
    },
  );

  it('the widget read endpoint, nested under /v1/chat/conversations, gets the SAME open CORS policy on a real request too', async () => {
    app = await bootApp();
    const res = await request(app.getHttpServer()).get('/v1/chat/conversations/abc/messages').set('Origin', 'https://embedding-site.example');

    expect(res.status).toBe(503);
    expect(res.headers['access-control-allow-origin']).toBe('*');
  });

  it('a non-chat /v1/* path carries NO CORS header at all, even with an Origin present', async () => {
    app = await bootApp();
    const res = await request(app.getHttpServer()).get('/v1/policies').set('Origin', 'https://embedding-site.example');

    expect(res.status).toBe(503);
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
    expect(res.headers['access-control-allow-credentials']).toBeUndefined();
  });

  it('a non-chat path never gets a permissive CORS preflight response either', async () => {
    app = await bootApp();
    const res = await request(app.getHttpServer())
      .options('/v1/policies')
      .set('Origin', 'https://embedding-site.example')
      .set('Access-Control-Request-Method', 'GET');

    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });
});
