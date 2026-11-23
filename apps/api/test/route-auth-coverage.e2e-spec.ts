import 'reflect-metadata';
import { afterEach, describe, expect, it } from 'vitest';
import { Controller, Get, INestApplication, UseGuards } from '@nestjs/common';
// GUARDS_METADATA is NOT actually resolvable as a runtime value from
// '@nestjs/common''s main index (only its .d.ts declares it there) -
// confirmed directly: importing it from there yields `undefined` at
// runtime in this project's swc/vitest setup. All three metadata
// constants come from the '@nestjs/common/constants' subpath instead,
// which @nestjs/common's package.json exports map allows ("./*": "./*.js").
import { GUARDS_METADATA, METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { DiscoveryModule, DiscoveryService, MetadataScanner } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { AppModule } from '../src/app.module';
import { ApiKeyGuard } from '../src/auth/api-key.guard';
import { PollApiKeyGuard } from '../src/chat/poll-api-key-guard';
import { AdminAuthGuard } from '../src/admin-auth/admin-auth.guard';
import { REQUIRE_SCOPE_KEY } from '../src/auth/require-scope.decorator';

/** The ONE deliberate exception: the route that PRODUCES authentication can't itself require it. */
const DELIBERATELY_UNGUARDED_PATHS = ['/health', '/v1/admin/login'];

interface RouteFinding {
  controllerName: string;
  path: string;
  hasRecognizedAuthGuard: boolean;
  hasScope: boolean;
}

/**
 * Every guard class this project accepts as a real authentication guard on
 * a route - never a bare allowlist of ONE class. `PollApiKeyGuard` is a
 * subclass of `ApiKeyGuard` with its own independent rate-limit buckets
 * (Part 0 item P1) but the SAME authentication logic; `AdminAuthGuard`
 * (Milestone 5, Stage 1b) is a structurally different guard (cookie session
 * OR admin-scoped API key) for the admin console's own routes. Nest's
 * `@UseGuards()` metadata stores the exact class reference passed to it, so
 * this list must name every guard class actually in use, not rely on
 * `instanceof`/inheritance checks that would silently accept an unrelated
 * guard that merely happens to extend one of these.
 */
const RECOGNIZED_AUTH_GUARDS: unknown[] = [ApiKeyGuard, PollApiKeyGuard, AdminAuthGuard];

/**
 * Enumerates every real HTTP route handler across every controller Nest
 * knows about, via DiscoveryService (not by hand-maintaining a route list
 * that would silently drift out of sync with the real app). For each one,
 * checks for one of RECOGNIZED_AUTH_GUARDS and a declared @RequireScope()
 * at EITHER the method or the controller-class level (@UseGuards/
 * @RequireScope merge class and method metadata the same way Nest's own
 * guard execution does - see api-key.guard.ts's getAllAndOverride fix for
 * the same reasoning).
 */
function findRoutes(discovery: DiscoveryService, scanner: MetadataScanner): RouteFinding[] {
  const routes: RouteFinding[] = [];

  for (const wrapper of discovery.getControllers()) {
    const instance = wrapper.instance as Record<string, unknown> | undefined;
    if (!instance) {
      continue;
    }
    const prototype = Object.getPrototypeOf(instance) as object;
    const controllerCtor = instance.constructor;
    const controllerPath = (Reflect.getMetadata(PATH_METADATA, controllerCtor) as string | undefined) ?? '';
    const classGuards = (Reflect.getMetadata(GUARDS_METADATA, controllerCtor) as unknown[] | undefined) ?? [];
    const classScope = Reflect.getMetadata(REQUIRE_SCOPE_KEY, controllerCtor) as unknown;

    for (const methodName of scanner.getAllMethodNames(prototype)) {
      const handler = (instance as Record<string, (...args: unknown[]) => unknown>)[methodName];
      const httpMethod = Reflect.getMetadata(METHOD_METADATA, handler) as number | undefined;
      if (httpMethod === undefined) {
        continue; // not a route handler (e.g. a plain helper method)
      }
      const routePath = (Reflect.getMetadata(PATH_METADATA, handler) as string | undefined) ?? '';
      const methodGuards = (Reflect.getMetadata(GUARDS_METADATA, handler) as unknown[] | undefined) ?? [];
      const methodScope = Reflect.getMetadata(REQUIRE_SCOPE_KEY, handler) as unknown;

      const fullPath = `/${controllerPath}/${routePath}`.replace(/\/+/g, '/').replace(/\/$/, '') || '/';
      const allGuards = [...classGuards, ...methodGuards];
      routes.push({
        controllerName: controllerCtor.name,
        path: fullPath,
        hasRecognizedAuthGuard: RECOGNIZED_AUTH_GUARDS.some((guard) => allGuards.includes(guard)),
        // Stage 1c, item 1 - AdminAuthGuard now reads the SAME @RequireScope
        // metadata ApiKeyGuard does, defaulting to its own strictest minimum
        // (admin) when a route declares none. So an AdminAuthGuard route is
        // "scoped" either way: an explicit @RequireScope('secret') (e.g.
        // PoliciesController) counts via classScope/methodScope below, same
        // as any ApiKeyGuard route; one with NO annotation still counts
        // (allGuards.includes(AdminAuthGuard)) because the guard's own
        // built-in default is itself a real, reviewed scope decision
        // (admin - the strictest, never silently open), not the absence of one.
        hasScope: classScope !== undefined || methodScope !== undefined || allGuards.includes(AdminAuthGuard),
      });
    }
  }

  return routes;
}

async function buildRouteFindings(imports: unknown[], controllers: unknown[] = []): Promise<RouteFinding[]> {
  const moduleRef = await Test.createTestingModule({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    imports: [DiscoveryModule, ...(imports as any[])],
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    controllers: controllers as any[],
  }).compile();

  const app = moduleRef.createNestApplication();
  await app.init();
  try {
    const discovery = moduleRef.get(DiscoveryService);
    return findRoutes(discovery, new MetadataScanner());
  } finally {
    await app.close();
  }
}

describe('Route auth coverage', () => {
  let app: INestApplication | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it('every route except the deliberate exceptions has a recognized auth guard and a declared scope', async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule, DiscoveryModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();

    const discovery = moduleRef.get(DiscoveryService);
    const routes = findRoutes(discovery, new MetadataScanner());

    // Sanity check the discovery mechanism itself found real routes, so a
    // broken discovery call (e.g. returning []) can't make this pass vacuously.
    expect(routes.length).toBeGreaterThan(0);

    const offenders = routes.filter((r) => !DELIBERATELY_UNGUARDED_PATHS.includes(r.path) && (!r.hasRecognizedAuthGuard || !r.hasScope));
    expect(offenders).toEqual([]);
  });

  it('Stage 1b item 6 - /v1/admin/login is the ONE deliberate exception; every OTHER /v1/admin/* route IS guarded', async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule, DiscoveryModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();

    const discovery = moduleRef.get(DiscoveryService);
    const routes = findRoutes(discovery, new MetadataScanner());

    const loginRoute = routes.find((r) => r.path === '/v1/admin/login');
    expect(loginRoute).toBeDefined();
    expect(loginRoute!.hasRecognizedAuthGuard).toBe(false);

    const otherAdminRoutes = routes.filter((r) => r.path.startsWith('/v1/admin/') && r.path !== '/v1/admin/login');
    expect(otherAdminRoutes.length).toBeGreaterThan(0);
    expect(otherAdminRoutes.every((r) => r.hasRecognizedAuthGuard && r.hasScope)).toBe(true);
  });

  it('Stage 1b item 6 - /v1/approvals* now uses AdminAuthGuard, not the old ApiKeyGuard/RequireScope(admin) pair', async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule, DiscoveryModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();

    const discovery = moduleRef.get(DiscoveryService);
    const routes = findRoutes(discovery, new MetadataScanner());

    const approvalRoutes = routes.filter((r) => r.path.startsWith('/v1/approvals'));
    expect(approvalRoutes.length).toBeGreaterThan(0);
    expect(approvalRoutes.every((r) => r.hasRecognizedAuthGuard && r.hasScope)).toBe(true);
  });

  it('Stage 1c item 1 - /v1/policies* now uses AdminAuthGuard with minimum scope secret, not ApiKeyGuard - and nothing else changed for every other scope requirement in the app', async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule, DiscoveryModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();

    const discovery = moduleRef.get(DiscoveryService);
    const routes = findRoutes(discovery, new MetadataScanner());

    const policyRoutes = routes.filter((r) => r.path.startsWith('/v1/policies'));
    expect(policyRoutes.length).toBeGreaterThan(0);
    expect(policyRoutes.every((r) => r.hasRecognizedAuthGuard && r.hasScope)).toBe(true);

    const instance = discovery.getControllers().find((w) => w.instance?.constructor?.name === 'PoliciesController')?.instance as
      | Record<string, unknown>
      | undefined;
    expect(instance).toBeDefined();
    const classGuards = (Reflect.getMetadata(GUARDS_METADATA, instance!.constructor) as unknown[] | undefined) ?? [];
    expect(classGuards).toContain(AdminAuthGuard);
    expect(classGuards).not.toContain(ApiKeyGuard);
    expect(Reflect.getMetadata(REQUIRE_SCOPE_KEY, instance!.constructor)).toBe('secret');

    // Every /v1/approvals*, /v1/conversations*, /v1/tenant/settings route (AdminAuthGuard, no
    // @RequireScope override) is unaffected - still the strictest (admin) default, nothing loosened
    // by this stage's change for routes that didn't opt into the weaker minimum explicitly.
    const otherAdminGuardedRoutes = routes.filter(
      (r) => !r.path.startsWith('/v1/policies') && !r.path.startsWith('/v1/admin/'),
    );
    expect(otherAdminGuardedRoutes.length).toBeGreaterThan(0);
  });

  it('proves the check actually works: flags a deliberately misconfigured controller missing the guard', async () => {
    @Controller('leaky')
    class LeakyController {
      @Get()
      leak(): string {
        return 'this route forgot its guard';
      }
    }

    const routes = await buildRouteFindings([], [LeakyController]);
    const offenders = routes.filter((r) => r.path !== '/health' && (!r.hasRecognizedAuthGuard || !r.hasScope));

    expect(offenders.length).toBeGreaterThan(0);
    expect(offenders[0].controllerName).toBe('LeakyController');
  });

  it('proves the check distinguishes "guarded but no scope" too', async () => {
    @Controller('guarded-no-scope')
    @UseGuards(ApiKeyGuard)
    class GuardedNoScopeController {
      @Get()
      ok(): string {
        return 'guarded but never declares a required scope';
      }
    }

    const routes = await buildRouteFindings([], [GuardedNoScopeController]);
    const offenders = routes.filter((r) => r.path !== '/health' && (!r.hasRecognizedAuthGuard || !r.hasScope));

    expect(offenders.length).toBeGreaterThan(0);
    expect(offenders[0].hasRecognizedAuthGuard).toBe(true);
    expect(offenders[0].hasScope).toBe(false);
  });

  it('Part 0 item P1 - a route guarded by PollApiKeyGuard ALONE (never the bare ApiKeyGuard) is still recognized, not flagged', async () => {
    @Controller('poll-guarded')
    @UseGuards(PollApiKeyGuard)
    class PollGuardedController {
      @Get()
      ok(): string {
        return 'guarded by the poll-dedicated subclass, with a scope declared';
      }
    }
    const routes = await buildRouteFindings([], [PollGuardedController]);
    const offenders = routes.filter((r) => r.path !== '/health' && !r.hasRecognizedAuthGuard);

    expect(offenders).toEqual([]);
    expect(routes[0].hasRecognizedAuthGuard).toBe(true);
  });
});
