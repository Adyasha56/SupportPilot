import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';
import { loadBootstrapSettingsFromEnv } from './bootstrap-settings';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);

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
