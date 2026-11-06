import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Body, Controller, INestApplication, Logger, Post, UseGuards } from '@nestjs/common';
import { NestExpressApplication } from '@nestjs/platform-express';
import { Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { API_KEY_GUARD_SETTINGS, ApiKeyGuard, ApiKeyGuardSettings } from './api-key.guard';
import { RequireScope } from './require-scope.decorator';
import { CurrentTenant } from './current-tenant.decorator';
import { CurrentApiKeyId, CurrentApiKeyScope } from './current-api-key.decorator';
import { ApiKeyScope } from '../db/schemas/api-key.schema';
import { API_KEY_REPOSITORY, ApiKeyLookup, ApiKeyRepository } from '../db/api-key.repository';
import { TENANT_REPOSITORY } from '../db/tenant.repository';
import { InMemoryApiKeyRepository } from '../db/test-utils/in-memory-api-key.repository';
import { InMemoryTenantRepository } from '../db/test-utils/in-memory-tenant.repository';
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

  @Post('public-only')
  @UseGuards(ApiKeyGuard)
  @RequireScope('public')
  publicOnly(@CurrentTenant() tenantId: string) {
    return { resolvedTenantId: tenantId };
  }

  @Post('whoami')
  @UseGuards(ApiKeyGuard)
  whoami(@CurrentApiKeyScope() matchedScope: ApiKeyScope, @CurrentApiKeyId() apiKeyId: string) {
    return { matchedScope, apiKeyId };
  }
}

/** Throws if findByHash is ever called - proves a rejection happened before the database was touched. */
class ThrowingApiKeyRepository implements ApiKeyRepository {
  create(): Promise<string> {
    throw new Error('should never be called in this test');
  }
  findByHash(): Promise<ApiKeyLookup | null> {
    throw new Error('findByHash should never be called - the limiter must reject before any database read');
  }
  revoke(): Promise<boolean> {
    throw new Error('should never be called in this test');
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

  describe('the one-directional secret/public scope relationship (Stage 3)', () => {
    it('a public-scope key never satisfies a secret-only route - the identical generic 401', async () => {
      const { rawKey } = await createKey('acme', 'public');
      const res = await request(app.getHttpServer()).post('/test/secret-only').set('Authorization', `Bearer ${rawKey}`).send({});
      expect(res.status).toBe(401);
      expect(res.body).toMatchObject({ statusCode: 401, message: 'Unauthorized' });
    });

    it('a secret-scope key satisfies the public-only route', async () => {
      const { rawKey } = await createKey('acme', 'secret');
      const res = await request(app.getHttpServer()).post('/test/public-only').set('Authorization', `Bearer ${rawKey}`).send({});
      expect(res.status).toBe(201);
      expect(res.body.resolvedTenantId).toBe('acme');
    });

    it('a public-scope key satisfies the public-only route (its own scope)', async () => {
      const { rawKey } = await createKey('acme', 'public');
      const res = await request(app.getHttpServer()).post('/test/public-only').set('Authorization', `Bearer ${rawKey}`).send({});
      expect(res.status).toBe(201);
    });

    it('matchedScope reports secret (the key\'s own highest capability) even on a public-only route', async () => {
      const { rawKey } = await createKey('acme', 'secret');
      const res = await request(app.getHttpServer()).post('/test/whoami').set('Authorization', `Bearer ${rawKey}`).send({});
      expect(res.body.matchedScope).toBe('secret');
    });

    it('matchedScope reports public for a pure public-scope key, and carries the real key id', async () => {
      const { rawKey, id } = await createKey('acme', 'public');
      const res = await request(app.getHttpServer()).post('/test/whoami').set('Authorization', `Bearer ${rawKey}`).send({});
      expect(res.body.matchedScope).toBe('public');
      expect(res.body.apiKeyId).toBe(id);
    });
  });
});

describe('ApiKeyGuard: per-IP and per-key rate limiting (Stage 3)', () => {
  let app: INestApplication;
  let repository: InMemoryApiKeyRepository;

  async function buildApp(settings: ApiKeyGuardSettings, repo: ApiKeyRepository = repository): Promise<INestApplication> {
    const moduleRef = await Test.createTestingModule({
      controllers: [TestController],
      providers: [
        ApiKeyGuard,
        Reflector,
        { provide: API_KEY_REPOSITORY, useValue: repo },
        { provide: API_KEY_GUARD_SETTINGS, useValue: settings },
      ],
    }).compile();
    const built = moduleRef.createNestApplication();
    await built.init();
    return built;
  }

  beforeEach(() => {
    repository = new InMemoryApiKeyRepository();
  });

  afterEach(async () => {
    await app?.close();
  });

  it('a per-IP limiter hit returns 429 with Retry-After, before the database is ever touched', async () => {
    app = await buildApp(
      { ipRateLimit: { maxRequests: 1, windowMs: 60_000, maxEntries: 100 }, keyRateLimit: { maxRequests: 1000, windowMs: 60_000, maxEntries: 100 } },
      new ThrowingApiKeyRepository(), // would throw if findByHash were ever reached
    );

    const first = await request(app.getHttpServer()).post('/test/open').send({});
    expect(first.status).toBe(401); // no Authorization header, but the IP limiter's own single ticket is already spent just by making the request

    const second = await request(app.getHttpServer()).post('/test/open').send({});
    expect(second.status).toBe(429);
    expect(second.body).toMatchObject({ statusCode: 429, code: 'RATE_LIMITED' });
    expect(second.headers['retry-after']).toBeDefined();
  });

  it('the per-KEY limiter rejects a valid key\'s own excess requests with 429', async () => {
    app = await buildApp({
      ipRateLimit: { maxRequests: 1000, windowMs: 60_000, maxEntries: 100 },
      keyRateLimit: { maxRequests: 1, windowMs: 60_000, maxEntries: 100 },
    });
    const rawKey = generateRawApiKey();
    const hash = hashApiKey(rawKey);
    await repository.create('acme', hash, getKeyPrefix(rawKey), ['secret']);

    const first = await request(app.getHttpServer()).post('/test/open').set('Authorization', `Bearer ${rawKey}`).send({});
    expect(first.status).toBe(201);

    const second = await request(app.getHttpServer()).post('/test/open').set('Authorization', `Bearer ${rawKey}`).send({});
    expect(second.status).toBe(429);
  });

  it('spoofed X-Forwarded-For at 0 trusted hops cannot evade the per-IP limiter via identity rotation', async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [TestController],
      providers: [
        ApiKeyGuard,
        Reflector,
        { provide: API_KEY_REPOSITORY, useValue: repository },
        {
          provide: API_KEY_GUARD_SETTINGS,
          useValue: { ipRateLimit: { maxRequests: 1, windowMs: 60_000, maxEntries: 100 }, keyRateLimit: { maxRequests: 1000, windowMs: 60_000, maxEntries: 100 } },
        },
      ],
    }).compile();
    const expressApp = moduleRef.createNestApplication<NestExpressApplication>();
    expressApp.set('trust proxy', 0); // the project default (bootstrap-settings.ts) - nothing is trusted
    await expressApp.init();
    app = expressApp;

    const first = await request(app.getHttpServer()).post('/test/open').set('X-Forwarded-For', '203.0.113.1').send({});
    expect(first.status).toBe(401); // real connecting IP's single ticket spent

    // A different claimed identity per request never helps - at 0 trusted
    // hops, req.ip always resolves to the real connecting address, so this
    // still hits the SAME bucket as the request above.
    const second = await request(app.getHttpServer()).post('/test/open').set('X-Forwarded-For', '198.51.100.77').send({});
    expect(second.status).toBe(429);
  });
});

describe('ApiKeyGuard: the Origin speed bump (Stage 3) - never blocks, never logs the raw header', () => {
  let app: INestApplication;
  let repository: InMemoryApiKeyRepository;
  let tenantRepository: InMemoryTenantRepository;

  beforeEach(async () => {
    repository = new InMemoryApiKeyRepository();
    tenantRepository = new InMemoryTenantRepository();
    const moduleRef = await Test.createTestingModule({
      controllers: [TestController],
      providers: [
        ApiKeyGuard,
        Reflector,
        { provide: API_KEY_REPOSITORY, useValue: repository },
        { provide: TENANT_REPOSITORY, useValue: tenantRepository },
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterEach(async () => {
    await app.close();
  });

  async function createKey(tenantId: string, scope: ApiKeyScope) {
    const rawKey = generateRawApiKey();
    const hash = hashApiKey(rawKey);
    await repository.create(tenantId, hash, getKeyPrefix(rawKey), [scope]);
    return rawKey;
  }

  it('a mismatched Origin never blocks the request - the response still succeeds', async () => {
    tenantRepository.setAllowedOrigins('acme', ['https://widget.acme.example']);
    const rawKey = await createKey('acme', 'public');

    const res = await request(app.getHttpServer())
      .post('/test/open')
      .set('Authorization', `Bearer ${rawKey}`)
      .set('Origin', 'https://attacker.example')
      .send({});

    expect(res.status).toBe(201); // never blocked - a speed bump, not security
  });

  it('logs only a boolean/count on mismatch, never the raw Origin header value', async () => {
    tenantRepository.setAllowedOrigins('acme', ['https://widget.acme.example']);
    const rawKey = await createKey('acme', 'public');
    const warnSpy = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

    await request(app.getHttpServer())
      .post('/test/open')
      .set('Authorization', `Bearer ${rawKey}`)
      .set('Origin', 'https://attacker.example')
      .send({});

    const logged = warnSpy.mock.calls.flat().map(String).join('\n');
    expect(logged).toContain('public_key_origin_mismatch');
    expect(logged).not.toContain('https://attacker.example');
    vi.restoreAllMocks();
  });

  it('skips the check entirely (no mismatch logged) when the tenant has no allowedOrigins configured', async () => {
    const rawKey = await createKey('acme', 'public'); // no setAllowedOrigins call at all
    const warnSpy = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

    const res = await request(app.getHttpServer())
      .post('/test/open')
      .set('Authorization', `Bearer ${rawKey}`)
      .set('Origin', 'https://anything.example')
      .send({});

    expect(res.status).toBe(201);
    expect(warnSpy.mock.calls.flat().map(String).join('\n')).not.toContain('public_key_origin_mismatch');
    vi.restoreAllMocks();
  });

  it('is never applied to a secret-scope key at all, regardless of Origin', async () => {
    tenantRepository.setAllowedOrigins('acme', ['https://widget.acme.example']);
    const rawKey = await createKey('acme', 'secret');
    const warnSpy = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

    const res = await request(app.getHttpServer())
      .post('/test/open')
      .set('Authorization', `Bearer ${rawKey}`)
      .set('Origin', 'https://attacker.example')
      .send({});

    expect(res.status).toBe(201);
    expect(warnSpy.mock.calls.flat().map(String).join('\n')).not.toContain('public_key_origin_mismatch');
    vi.restoreAllMocks();
  });
});
