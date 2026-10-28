import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Body, Controller, INestApplication, Post, UseGuards } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { ApiKeyGuard } from './api-key.guard';
import { RequireScope } from './require-scope.decorator';
import { CurrentTenant } from './current-tenant.decorator';
import { API_KEY_REPOSITORY } from '../db/api-key.repository';
import { InMemoryApiKeyRepository } from '../db/test-utils/in-memory-api-key.repository';
import { generateRawApiKey, getKeyPrefix, hashApiKey } from './api-key.service';

@Controller('test')
class TestController {
  @Post('open')
  @UseGuards(ApiKeyGuard)
  open(@CurrentTenant() tenantId: string, @Body() body: { tenantId?: string }) {
    return { resolvedTenantId: tenantId, bodySuppliedTenantId: body?.tenantId ?? null };
  }

  @Post('secret-only')
  @UseGuards(ApiKeyGuard)
  @RequireScope('secret')
  secretOnly(@CurrentTenant() tenantId: string) {
    return { resolvedTenantId: tenantId };
  }
}

describe('ApiKeyGuard', () => {
  let app: INestApplication;
  let repository: InMemoryApiKeyRepository;

  beforeEach(async () => {
    repository = new InMemoryApiKeyRepository();
    const moduleRef = await Test.createTestingModule({
      controllers: [TestController],
      providers: [ApiKeyGuard, Reflector, { provide: API_KEY_REPOSITORY, useValue: repository }],
    }).compile();

    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterEach(async () => {
    await app.close();
  });

  async function createKey(tenantId: string, scope: 'public' | 'secret' = 'secret') {
    const rawKey = generateRawApiKey();
    const hash = hashApiKey(rawKey);
    const id = await repository.create(tenantId, hash, getKeyPrefix(rawKey), [scope]);
    return { rawKey, hash, id };
  }

  it('resolves tenantId from a valid key', async () => {
    const { rawKey } = await createKey('acme');
    const res = await request(app.getHttpServer())
      .post('/test/open')
      .set('Authorization', `Bearer ${rawKey}`)
      .send({});
    expect(res.status).toBe(201);
    expect(res.body.resolvedTenantId).toBe('acme');
  });

  it('ignores a body-supplied tenantId entirely', async () => {
    const { rawKey } = await createKey('acme');
    const res = await request(app.getHttpServer())
      .post('/test/open')
      .set('Authorization', `Bearer ${rawKey}`)
      .send({ tenantId: 'some-other-tenant' });
    expect(res.status).toBe(201);
    expect(res.body.resolvedTenantId).toBe('acme');
    expect(res.body.bodySuppliedTenantId).toBe('some-other-tenant'); // present in body, but never used for resolution
  });

  it('requires the secret scope for a scoped route', async () => {
    const { rawKey } = await createKey('acme', 'secret');
    const res = await request(app.getHttpServer())
      .post('/test/secret-only')
      .set('Authorization', `Bearer ${rawKey}`)
      .send({});
    expect(res.status).toBe(201);
  });

  describe('every failure mode returns the identical generic 401', () => {
    const genericBody = { statusCode: 401, message: 'Unauthorized' };

    it('missing Authorization header', async () => {
      const res = await request(app.getHttpServer()).post('/test/open').send({});
      expect(res.status).toBe(401);
      expect(res.body).toMatchObject(genericBody);
    });

    it('malformed header (no Bearer prefix)', async () => {
      const { rawKey } = await createKey('acme');
      const res = await request(app.getHttpServer())
        .post('/test/open')
        .set('Authorization', rawKey)
        .send({});
      expect(res.status).toBe(401);
      expect(res.body).toMatchObject(genericBody);
    });

    it('unknown key', async () => {
      const res = await request(app.getHttpServer())
        .post('/test/open')
        .set('Authorization', `Bearer ${generateRawApiKey()}`)
        .send({});
      expect(res.status).toBe(401);
      expect(res.body).toMatchObject(genericBody);
    });

    it('revoked key', async () => {
      const { rawKey, id } = await createKey('acme');
      await repository.revoke(id);
      const res = await request(app.getHttpServer())
        .post('/test/open')
        .set('Authorization', `Bearer ${rawKey}`)
        .send({});
      expect(res.status).toBe(401);
      expect(res.body).toMatchObject(genericBody);
    });

    it('missing required scope', async () => {
      const { rawKey } = await createKey('acme', 'public');
      const res = await request(app.getHttpServer())
        .post('/test/secret-only')
        .set('Authorization', `Bearer ${rawKey}`)
        .send({});
      expect(res.status).toBe(401);
      expect(res.body).toMatchObject(genericBody);
    });
  });

  describe('nothing sensitive is ever logged or echoed back', () => {
    it('neither the raw key nor its hash appear in logs across success and every failure mode', async () => {
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

      const { rawKey, hash, id } = await createKey('acme');

      await request(app.getHttpServer()).post('/test/open').set('Authorization', `Bearer ${rawKey}`).send({});
      await repository.revoke(id);
      const revokedRes = await request(app.getHttpServer())
        .post('/test/open')
        .set('Authorization', `Bearer ${rawKey}`)
        .send({});
      const unknownRes = await request(app.getHttpServer())
        .post('/test/open')
        .set('Authorization', `Bearer ${generateRawApiKey()}`)
        .send({});

      const loggedText = [...logSpy.mock.calls, ...errorSpy.mock.calls, ...warnSpy.mock.calls]
        .flat()
        .map(String)
        .join('\n');

      expect(loggedText).not.toContain(rawKey);
      expect(loggedText).not.toContain(hash);
      expect(JSON.stringify(revokedRes.body)).not.toContain(rawKey);
      expect(JSON.stringify(revokedRes.body)).not.toContain(hash);
      expect(JSON.stringify(unknownRes.body)).not.toContain(rawKey);

      vi.restoreAllMocks();
    });
  });
});
