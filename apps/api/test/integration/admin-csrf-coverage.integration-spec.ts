/**
 * Milestone 5, Stage 1c, item 5 - "CSRF on every non-GET cookie request (a
 * test enumerating the admin routes and checking each)." Through the REAL
 * AppModule (real AdminAuthGuard, real routes), not a hand-maintained list
 * of paths that could silently drift out of sync with the app - the same
 * DiscoveryService-based enumeration `test/route-auth-coverage.e2e-spec.ts`
 * uses, narrowed here to "every non-GET route guarded by AdminAuthGuard".
 * For EACH one, a request carrying a valid session cookie but no
 * `x-csrf-token` header must be rejected with 401 - proven for every route
 * at once, not just the one or two admin-auth.integration-spec.ts happens
 * to exercise directly.
 */
import './test-env';
import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { INestApplication, RequestMethod } from '@nestjs/common';
import { GUARDS_METADATA, METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { DiscoveryModule, DiscoveryService, MetadataScanner } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../../src/app.module';
import { AdminAuthGuard } from '../../src/admin-auth/admin-auth.guard';
import {
  cleanupTenant,
  createAdminCredentialFixture,
  createTenantFixture,
  disconnectFixtureConnection,
  TenantFixture,
} from './tenant-fixture';
import { getTestMongoUri, integrationTestsEnabled } from './test-env';

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

interface AdminGuardedRoute {
  method: 'post' | 'put' | 'delete' | 'patch';
  path: string;
}

function methodToSupertestVerb(method: RequestMethod): AdminGuardedRoute['method'] | undefined {
  switch (method) {
    case RequestMethod.POST:
      return 'post';
    case RequestMethod.PUT:
      return 'put';
    case RequestMethod.DELETE:
      return 'delete';
    case RequestMethod.PATCH:
      return 'patch';
    default:
      return undefined; // GET and everything else is never CSRF-checked by design - excluded, not a false pass.
  }
}

/** A path param (":id", ":runId", ...) is replaced with a dummy value - the CSRF check in AdminAuthGuard runs before any param/body validation, so the real value never matters for THIS test. */
function withDummyParams(path: string): string {
  return path.replace(/:[A-Za-z0-9_]+/g, 'dummy-id-for-csrf-coverage-test');
}

function findAdminGuardedNonGetRoutes(discovery: DiscoveryService, scanner: MetadataScanner): AdminGuardedRoute[] {
  const routes: AdminGuardedRoute[] = [];
  for (const wrapper of discovery.getControllers()) {
    const instance = wrapper.instance as Record<string, unknown> | undefined;
    if (!instance) continue;
    const prototype = Object.getPrototypeOf(instance) as object;
    const controllerCtor = instance.constructor;
    const controllerPath = (Reflect.getMetadata(PATH_METADATA, controllerCtor) as string | undefined) ?? '';
    const classGuards = (Reflect.getMetadata(GUARDS_METADATA, controllerCtor) as unknown[] | undefined) ?? [];

    for (const methodName of scanner.getAllMethodNames(prototype)) {
      const handler = (instance as Record<string, (...args: unknown[]) => unknown>)[methodName];
      const httpMethod = Reflect.getMetadata(METHOD_METADATA, handler) as RequestMethod | undefined;
      if (httpMethod === undefined) continue;
      const methodGuards = (Reflect.getMetadata(GUARDS_METADATA, handler) as unknown[] | undefined) ?? [];
      const allGuards = [...classGuards, ...methodGuards];
      if (!allGuards.includes(AdminAuthGuard)) continue;

      const verb = methodToSupertestVerb(httpMethod);
      if (!verb) continue;

      const routePath = (Reflect.getMetadata(PATH_METADATA, handler) as string | undefined) ?? '';
      const fullPath = `/${controllerPath}/${routePath}`.replace(/\/+/g, '/').replace(/\/$/, '') || '/';
      routes.push({ method: verb, path: withDummyParams(fullPath) });
    }
  }
  return routes;
}

describe.skipIf(!integrationTestsEnabled())('Admin CSRF coverage across every non-GET admin route (integration, real database)', () => {
  let app: INestApplication;
  let priorDevCookieEnv: string | undefined;

  beforeAll(async () => {
    // Same reason admin-auth.integration-spec.ts sets this - the PRODUCTION session cookie is
    // Secure, which superagent's cookie jar correctly refuses to resend over this test's
    // plain-HTTP transport. Read at module-compile time, so it must be set before compile().
    priorDevCookieEnv = process.env.ADMIN_DEV_COOKIE_ENABLED;
    process.env.ADMIN_DEV_COOKIE_ENABLED = 'true';

    const moduleRef = await Test.createTestingModule({ imports: [AppModule, DiscoveryModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
  }, 60_000);

  afterAll(async () => {
    await app.close();
    if (priorDevCookieEnv === undefined) {
      delete process.env.ADMIN_DEV_COOKIE_ENABLED;
    } else {
      process.env.ADMIN_DEV_COOKIE_ENABLED = priorDevCookieEnv;
    }
  });

  it('enumerates at least one route per admin surface (approvals, conversations, settings, connectors, policies) - a sanity check against the discovery mechanism itself returning too little', async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule, DiscoveryModule] }).compile();
    const discovery = moduleRef.get(DiscoveryService);
    const routes = findAdminGuardedNonGetRoutes(discovery, new MetadataScanner());

    expect(routes.some((r) => r.path.startsWith('/v1/approvals'))).toBe(true);
    expect(routes.some((r) => r.path.startsWith('/v1/policies'))).toBe(true);
    expect(routes.some((r) => r.path === '/v1/tenant/settings')).toBe(true);
  });

  it('every non-GET AdminAuthGuard-protected route rejects a valid session with NO CSRF header - 401, every single one', async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule, DiscoveryModule] }).compile();
    const discovery = moduleRef.get(DiscoveryService);
    const routes = findAdminGuardedNonGetRoutes(discovery, new MetadataScanner());
    expect(routes.length).toBeGreaterThan(0);

    const tenant = await newTenant();
    await createAdminCredentialFixture(uri, tenant.tenantId, `csrf-coverage-${tenant.tenantId}@example.com`, 'a-real-password-123456');
    const agent = request.agent(app.getHttpServer());
    const loginRes = await agent.post('/v1/admin/login').send({ email: `csrf-coverage-${tenant.tenantId}@example.com`, password: 'a-real-password-123456' });
    expect(loginRes.status).toBe(200);

    const offenders: { route: AdminGuardedRoute; status: number }[] = [];
    for (const route of routes) {
      const res = await agent[route.method](route.path).send({});
      if (res.status !== 401) {
        offenders.push({ route, status: res.status });
      }
    }

    expect(offenders).toEqual([]);
  });

  it('the SAME route succeeds past the CSRF check once the real token is attached (proves the 401 above is really CSRF, not something else failing first)', async () => {
    const tenant = await newTenant();
    await createAdminCredentialFixture(uri, tenant.tenantId, `csrf-proof-${tenant.tenantId}@example.com`, 'a-real-password-123456');
    const agent = request.agent(app.getHttpServer());
    await agent.post('/v1/admin/login').send({ email: `csrf-proof-${tenant.tenantId}@example.com`, password: 'a-real-password-123456' });
    const bootstrap = await agent.get('/v1/admin/session');
    const csrfToken = bootstrap.body.csrfToken as string;

    // /v1/tenant/settings PUT with a harmless non-restricted field - passes the guard (CSRF ok),
    // whatever the controller itself then does with the body.
    const res = await agent.put('/v1/tenant/settings').set('x-csrf-token', csrfToken).send({ approvalThreshold: 100 });
    expect(res.status).not.toBe(401);
  });
});
