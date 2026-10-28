import { afterEach, describe, expect, it } from 'vitest';
import { Controller, Get, INestApplication, Req } from '@nestjs/common';
import { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import type { Request } from 'express';
import request from 'supertest';

/**
 * Exercises the exact setting main.ts applies (app.set('trust proxy', hops))
 * against a real Nest+Express app, not a hand-built Express instance - the
 * point is to prove THIS app's req.ip resolution, not Express's in general.
 */
@Controller('test')
class IpEchoController {
  @Get('ip')
  getIp(@Req() req: Request): { ip: string } {
    return { ip: req.ip ?? 'unknown' };
  }
}

async function buildApp(trustProxyHops: number): Promise<INestApplication> {
  const moduleRef = await Test.createTestingModule({ controllers: [IpEchoController] }).compile();
  const app = moduleRef.createNestApplication<NestExpressApplication>();
  app.set('trust proxy', trustProxyHops);
  await app.init();
  return app;
}

describe('trust proxy setting', () => {
  let app: INestApplication | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it('at 0 hops (the default), a spoofed X-Forwarded-For is ignored', async () => {
    app = await buildApp(0);
    const res = await request(app.getHttpServer()).get('/test/ip').set('X-Forwarded-For', '203.0.113.99');

    expect(res.body.ip).not.toBe('203.0.113.99');
  });

  it('at 1 hop, X-Forwarded-For is honored (matches a single-reverse-proxy deployment)', async () => {
    app = await buildApp(1);
    const res = await request(app.getHttpServer()).get('/test/ip').set('X-Forwarded-For', '203.0.113.99');

    expect(res.body.ip).toBe('203.0.113.99');
  });
});
