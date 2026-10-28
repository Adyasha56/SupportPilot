import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);

  // 'trust proxy', 1 means: trust the X-Forwarded-For value contributed by
  // exactly one hop in front of this process, and use it as req.ip (which
  // FailedAttemptLimiter keys on). This matches both real deployment
  // targets: Render's free web service terminates TLS and proxies directly
  // to this app (one hop), and local Docker Compose has no proxy at all, in
  // which case there's no X-Forwarded-For to trust and req.ip falls back to
  // the direct socket address regardless. Without this, every request
  // behind Render's proxy would resolve to the proxy's own IP, collapsing
  // the per-client limiter into one shared global bucket for all clients.
  app.set('trust proxy', 1);

  const port = process.env.API_PORT ?? 3000;
  await app.listen(port);
}

bootstrap();
