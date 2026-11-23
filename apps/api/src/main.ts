import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';
import { loadBootstrapSettingsFromEnv } from './bootstrap-settings';
import { ChatBodyParserErrorFilter } from './chat/chat-body-parser-error.filter';
import { buildCorsOptionsDelegate } from './common/cors';
import { securityHeadersMiddleware } from './common/security-headers.middleware';
import { loadServerSettingsFromEnv } from './common/server.settings';
import { registerAdminStaticAssets } from './common/admin-static';
import { registerWidgetStaticAssets } from './common/widget-static';
import { loadAdminAuthSettingsFromEnv } from './admin-auth/admin-auth.settings';
import { warnIfAdminOriginsMisconfigured } from './admin-auth/admin-origins-boot-check';

const bootLogger = new Logger('Bootstrap');

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);

  const serverSettings = loadServerSettingsFromEnv(process.env);

  // Part 0, item Q3 - ADMIN_ALLOWED_ORIGINS empty is a deliberate
  // fail-closed default (admin-auth.settings.ts), but silent. Warn once at
  // boot, in production only, with a count and a boolean - never an origin
  // string. loadAdminAuthSettingsFromEnv is pure env parsing (no database),
  // so this is safe to call here even before AppModule's own providers for
  // the same settings are resolved.
  warnIfAdminOriginsMisconfigured(loadAdminAuthSettingsFromEnv(process.env).allowedOrigins, process.env.NODE_ENV, (message) => bootLogger.warn(message));

  // Milestone 5, Stage 1a, amendment A5 - registered FIRST, before every
  // other middleware/filter/guard: Nest wires enableCors() as Express-level
  // middleware, so a browser's OPTIONS preflight is answered here, before
  // it could ever reach ApiKeyGuard (no API key is required to preflight).
  app.enableCors(buildCorsOptionsDelegate({ preflightMaxAgeSeconds: serverSettings.corsPreflightMaxAgeSeconds }));

  // Amendment A1/B6 - Cache-Control/X-Content-Type-Options everywhere except
  // widget assets, CSP/Referrer-Policy on the admin HTML shell only. Must
  // run before the static-asset registrations below so every response from
  // them (including a cache-busting miss that falls through to the admin
  // SPA fallback) already carries these headers.
  app.use(securityHeadersMiddleware);

  // Stage 6 item 3 - a body that fails to parse at all (too large, or
  // syntactically invalid JSON) throws from Nest's global body-parser
  // middleware, before any controller-scoped @UseFilters() ever sees it -
  // this MUST be a global filter (see chat-body-parser-error.filter.ts's
  // own doc comment for the empirical confirmation). It only reshapes
  // responses for the /v1/chat path; every other route's error handling
  // is unchanged (super.catch() for everything else). Constructed with
  // app.getHttpAdapter() explicitly, per Nest's own documented pattern for
  // a manually-instantiated BaseExceptionFilter subclass used as a global
  // filter (DI never wires applicationRef for a bare `new` instance).
  app.useGlobalFilters(new ChatBodyParserErrorFilter(app.getHttpAdapter()));

  // TRUST_PROXY_HOPS controls how many hops of X-Forwarded-For are trusted
  // when resolving req.ip (what FailedAttemptLimiter keys on). Defaults to
  // 0 - trust nothing - which is the only safe default without knowing the
  // deployment topology; this code never hardcodes a specific hop count.
  // Render's free web service (one reverse-proxy hop) sets TRUST_PROXY_HOPS=1
  // in its own env config; local Docker Compose has no proxy, so leaving it
  // at 0 is correct there too.
  const { trustProxyHops } = loadBootstrapSettingsFromEnv(process.env);
  app.set('trust proxy', trustProxyHops);

  // Amendment A1/B4/B6 - registered after the security-headers middleware
  // above so every response from either static root already carries it;
  // registered before listen() so they're active for the very first request.
  registerAdminStaticAssets(app, serverSettings.adminStaticDir);
  registerWidgetStaticAssets(app, serverSettings.widgetStaticDir, serverSettings.widgetVersion);

  const port = process.env.API_PORT ?? 3000;
  await app.listen(port);
}

bootstrap();
