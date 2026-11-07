import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';
import { loadBootstrapSettingsFromEnv } from './bootstrap-settings';
import { ChatBodyParserErrorFilter } from './chat/chat-body-parser-error.filter';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);

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

  const port = process.env.API_PORT ?? 3000;
  await app.listen(port);
}

bootstrap();
