import 'reflect-metadata';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { INestApplication, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { Controller, Get } from '@nestjs/common';
import { registerAdminStaticAssets } from '../src/common/admin-static';
import { registerWidgetStaticAssets } from '../src/common/widget-static';
import { securityHeadersMiddleware } from '../src/common/security-headers.middleware';

@Module({})
class TestAppModule {}

@Controller('v1/chat')
class FakeJsonApiController {
  @Get()
  ping(): { ok: true } {
    return { ok: true };
  }
}

@Module({ controllers: [FakeJsonApiController] })
class FakeJsonApiModule {}

async function bootApp(configure: (app: NestExpressApplication) => void): Promise<INestApplication> {
  const app = await NestFactory.create<NestExpressApplication>(TestAppModule, { logger: false });
  app.use(securityHeadersMiddleware);
  configure(app);
  await app.init();
  return app;
}

/** Every traversal variant item 6 asks for, against a mount at `prefix`. */
const TRAVERSAL_ATTEMPTS = (prefix: string): string[] => [
  `${prefix}/../secret-outside.txt`,
  `${prefix}/..%2fsecret-outside.txt`,
  `${prefix}/%2e%2e%2fsecret-outside.txt`,
  `${prefix}/%252e%252e%252fsecret-outside.txt`,
  `${prefix}/..\\secret-outside.txt`,
  `${prefix}/..%5csecret-outside.txt`,
];

describe('Static serving (amendments A1/B4/B6 - admin SPA + widget bundle, both served from this API process)', () => {
  let adminDir: string;
  let widgetDir: string;
  let outsideSecretPath: string;

  beforeAll(async () => {
    const root = await mkdtemp(join(tmpdir(), 'supportpilot-static-'));
    adminDir = join(root, 'admin-dist');
    widgetDir = join(root, 'widget-dist');
    await mkdir(adminDir, { recursive: true });
    await mkdir(join(adminDir, 'assets'), { recursive: true });
    await mkdir(widgetDir, { recursive: true });

    await writeFile(join(adminDir, 'index.html'), '<html>admin shell</html>', 'utf8');
    await writeFile(join(adminDir, 'assets', 'app.js'), 'console.log("admin bundle")', 'utf8');
    await writeFile(join(adminDir, '.env'), 'SHOULD_NEVER_BE_SERVED=1', 'utf8');
    await writeFile(join(widgetDir, 'widget.js'), 'console.log("widget bundle")', 'utf8');
    await writeFile(join(widgetDir, '.env'), 'SHOULD_NEVER_BE_SERVED=1', 'utf8');
    // Deliberately OUTSIDE both static roots, one level up - what a successful traversal would reach.
    outsideSecretPath = join(root, 'secret-outside.txt');
    await writeFile(outsideSecretPath, 'TOP SECRET - MUST NEVER BE SERVED', 'utf8');
  });

  afterAll(async () => {
    await rm(join(adminDir, '..', '..'), { recursive: true, force: true }).catch(() => undefined);
  });

  describe('admin static root', () => {
    let app: INestApplication;
    beforeAll(async () => {
      app = await bootApp((a) => registerAdminStaticAssets(a, adminDir));
    });
    afterAll(() => app.close());

    it('serves a real asset with the admin Cache-Control/X-Content-Type-Options, but NO CSP (it has a file extension)', async () => {
      const res = await request(app!.getHttpServer()).get('/admin/assets/app.js');
      expect(res.status).toBe(200);
      expect(res.text).toBe('console.log("admin bundle")');
      expect(res.headers['cache-control']).toBe('no-store');
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      expect(res.headers['content-security-policy']).toBeUndefined();
    });

    it('redirects the bare /admin path to /admin/ (serve-static\'s own directory-request behavior)', async () => {
      const res = await request(app!.getHttpServer()).get('/admin');
      expect(res.status).toBe(301);
      expect(res.headers.location).toBe('/admin/');
    });

    it('serves the SPA shell for /admin/, WITH the CSP and Referrer-Policy', async () => {
      const res = await request(app!.getHttpServer()).get('/admin/');
      expect(res.status).toBe(200);
      expect(res.text).toContain('admin shell');
      expect(res.headers['content-security-policy']).toContain("default-src 'self'");
      expect(res.headers['content-security-policy']).toContain("frame-ancestors 'none'");
      expect(res.headers['referrer-policy']).toBe('no-referrer');
    });

    it('falls back to the SPA shell for an unmatched client-routed deep link, still with the CSP', async () => {
      const res = await request(app!.getHttpServer()).get('/admin/approvals/some-id-123');
      expect(res.status).toBe(200);
      expect(res.text).toContain('admin shell');
      expect(res.headers['content-security-policy']).toBeDefined();
    });

    // Empirically confirmed against this project's real serve-static@2.2.1/send@1.2.1 (the exact
    // versions this app installs): serve-static's default `fallthrough: true` means a dotfile
    // DENY (or a traversal attempt) never reaches the client as its own distinct error - the
    // underlying `send` stream's error is swallowed and treated as a plain miss, which (on the
    // admin mount specifically) falls through to adminSpaFallback and gets the ordinary SPA
    // shell response (200), exactly like any other unmatched client-routed path. The actual
    // security property - the dotfile's own content is NEVER returned - still holds; only the
    // HTTP status this particular mount produces for a denied path is "200, SPA shell" rather
    // than a distinct 403/404. (The widget root below has no such fallback registered, so the
    // SAME attempts there DO surface as a plain 404 - see its own tests.)
    it('a dotfile is never served - the request falls through to the SPA shell, never the dotfile\'s content', async () => {
      const res = await request(app!.getHttpServer()).get('/admin/.env');
      expect(res.text).not.toContain('SHOULD_NEVER_BE_SERVED');
      expect(res.status).toBe(200);
      expect(res.text).toContain('admin shell');
    });

    it.each(TRAVERSAL_ATTEMPTS('/admin'))('never leaks content outside the admin root via traversal: %s', async (path) => {
      const res = await request(app!.getHttpServer()).get(path);
      expect(res.text).not.toContain('TOP SECRET');
    });

    it('never shadows an unmatched /v1/* route - that path gets Nest\'s own ordinary 404, never the admin shell', async () => {
      const res = await request(app!.getHttpServer()).get('/v1/totally-unknown-route');
      expect(res.status).toBe(404);
      expect(res.text).not.toContain('admin shell');
    });
  });

  describe('admin static root when the build directory does not exist yet', () => {
    let app: INestApplication;
    beforeAll(async () => {
      app = await bootApp((a) => registerAdminStaticAssets(a, join(adminDir, 'does-not-exist')));
    });
    afterAll(() => app.close());

    it('the app still boots and returns a clean, structured 404 - never a crash, never a default error page', async () => {
      const res = await request(app.getHttpServer()).get('/admin/whatever');
      expect(res.status).toBe(404);
      expect(res.body).toMatchObject({ statusCode: 404, code: 'NOT_FOUND' });
    });
  });

  describe('widget static root', () => {
    const widgetVersion = '1.2.3-test';
    let app: INestApplication;
    beforeAll(async () => {
      app = await bootApp((a) => registerWidgetStaticAssets(a, widgetDir, widgetVersion));
    });
    afterAll(() => app.close());

    it('serves the versioned path with a long, immutable Cache-Control - and the admin no-store header is NEVER applied here', async () => {
      const res = await request(app.getHttpServer()).get(`/widget/${widgetVersion}/widget.js`);
      expect(res.status).toBe(200);
      expect(res.text).toBe('console.log("widget bundle")');
      expect(res.headers['cache-control']).toBe('public, max-age=31536000, immutable');
      expect(res.headers['content-security-policy']).toBeUndefined();
      expect(res.headers['x-content-type-options']).toBeUndefined();
    });

    it('serves the short alias at a fixed, different, short-lived Cache-Control - same content', async () => {
      const res = await request(app.getHttpServer()).get('/widget.js');
      expect(res.status).toBe(200);
      expect(res.text).toBe('console.log("widget bundle")');
      expect(res.headers['cache-control']).toBe('public, max-age=300');
      expect(res.headers['content-security-policy']).toBeUndefined();
    });

    it('a request for any OTHER version segment is a plain 404 - this app only ever serves the one configured version', async () => {
      const res = await request(app.getHttpServer()).get('/widget/9.9.9-not-the-configured-version/widget.js');
      expect(res.status).toBe(404);
    });

    it('denies a dotfile under the widget root too', async () => {
      const res = await request(app.getHttpServer()).get(`/widget/${widgetVersion}/.env`);
      expect(res.status).not.toBe(200);
      expect(res.text).not.toContain('SHOULD_NEVER_BE_SERVED');
    });

    it.each(TRAVERSAL_ATTEMPTS(`/widget/${widgetVersion}`))('never escapes the widget root via traversal: %s', async (path) => {
      const res = await request(app.getHttpServer()).get(path);
      expect(res.status).not.toBe(200);
      expect(res.text).not.toContain('TOP SECRET');
    });
  });

  describe('a plain JSON /v1/* API response', () => {
    let app: INestApplication;
    beforeAll(async () => {
      app = await NestFactory.create<NestExpressApplication>(FakeJsonApiModule, { logger: false });
      app.use(securityHeadersMiddleware);
      await app.init();
    });
    afterAll(() => app.close());

    it('gets Cache-Control/X-Content-Type-Options, but NEVER a CSP or Referrer-Policy (those are admin-HTML-only)', async () => {
      const res = await request(app.getHttpServer()).get('/v1/chat');
      expect(res.status).toBe(200);
      expect(res.headers['cache-control']).toBe('no-store');
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      expect(res.headers['content-security-policy']).toBeUndefined();
      expect(res.headers['referrer-policy']).toBeUndefined();
    });
  });

  describe('widget static root when the build directory does not exist yet', () => {
    const widgetVersion = '0.0.0-unbuilt';
    let app: INestApplication;
    beforeAll(async () => {
      app = await bootApp((a) => registerWidgetStaticAssets(a, join(widgetDir, 'does-not-exist'), widgetVersion));
    });
    afterAll(() => app.close());

    it('the app still boots; the versioned path 404s cleanly', async () => {
      const res = await request(app.getHttpServer()).get(`/widget/${widgetVersion}/widget.js`);
      expect(res.status).toBe(404);
    });

    it('the short alias also 404s cleanly, with this project\'s own error shape', async () => {
      const res = await request(app.getHttpServer()).get('/widget.js');
      expect(res.status).toBe(404);
      expect(res.body).toMatchObject({ statusCode: 404, code: 'NOT_FOUND' });
    });
  });
});
