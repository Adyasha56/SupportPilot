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
import { REQUIRE_SCOPE_KEY } from '../src/auth/require-scope.decorator';

interface RouteFinding {
  controllerName: string;
  path: string;
  hasApiKeyGuard: boolean;
  hasScope: boolean;
}

/**
 * Enumerates every real HTTP route handler across every controller Nest
 * knows about, via DiscoveryService (not by hand-maintaining a route list
 * that would silently drift out of sync with the real app). For each one,
 * checks for ApiKeyGuard and a declared @RequireScope() at EITHER the
 * method or the controller-class level (@UseGuards/@RequireScope merge
 * class and method metadata the same way Nest's own guard execution does -
 * see api-key.guard.ts's getAllAndOverride fix for the same reasoning).
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
      routes.push({
        controllerName: controllerCtor.name,
        path: fullPath,
        hasApiKeyGuard: [...classGuards, ...methodGuards].includes(ApiKeyGuard),
        hasScope: classScope !== undefined || methodScope !== undefined,
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

  it('every route except /health has ApiKeyGuard and a declared scope', async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule, DiscoveryModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();

    const discovery = moduleRef.get(DiscoveryService);
    const routes = findRoutes(discovery, new MetadataScanner());

    // Sanity check the discovery mechanism itself found real routes, so a
    // broken discovery call (e.g. returning []) can't make this pass vacuously.
    expect(routes.length).toBeGreaterThan(0);

    const offenders = routes.filter((r) => r.path !== '/health' && (!r.hasApiKeyGuard || !r.hasScope));
    expect(offenders).toEqual([]);
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
    const offenders = routes.filter((r) => r.path !== '/health' && (!r.hasApiKeyGuard || !r.hasScope));

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
    const offenders = routes.filter((r) => r.path !== '/health' && (!r.hasApiKeyGuard || !r.hasScope));

    expect(offenders.length).toBeGreaterThan(0);
    expect(offenders[0].hasApiKeyGuard).toBe(true);
    expect(offenders[0].hasScope).toBe(false);
  });
});
