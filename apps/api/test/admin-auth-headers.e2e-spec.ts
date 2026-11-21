import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { securityHeadersMiddleware } from '../src/common/security-headers.middleware';
import { AdminAuthModule } from '../src/admin-auth/admin-auth.module';

/**
 * Milestone 5, Stage 1b, item 5 - "every response from admin and session
 * routes Cache-Control no-store". No database is configured here (no
 * MONGODB_URI) - AdminLoginController's own routes still exist and
 * respond (503/401, never a crash - the same "safe to import with no
 * database" discipline every other module in this project already
 * follows), which is enough to confirm the HEADER behavior without
 * needing a real credential or session at all.
 */
describe('Admin auth routes - Cache-Control: no-store (item 5)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await NestFactory.create<NestExpressApplication>(AdminAuthModule, { logger: false });
    app.use(securityHeadersMiddleware);
    await app.init();
  });
  afterAll(() => app.close());

  it('POST /v1/admin/login carries Cache-Control: no-store', async () => {
    const res = await request(app.getHttpServer()).post('/v1/admin/login').send({ email: 'a@b.com', password: 'whatever12345' });
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('GET /v1/admin/session carries Cache-Control: no-store even on a 401', async () => {
    const res = await request(app.getHttpServer()).get('/v1/admin/session');
    expect(res.status).toBe(401);
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('POST /v1/admin/logout carries Cache-Control: no-store even on a 401', async () => {
    const res = await request(app.getHttpServer()).post('/v1/admin/logout');
    expect(res.status).toBe(401);
    expect(res.headers['cache-control']).toBe('no-store');
  });
});
