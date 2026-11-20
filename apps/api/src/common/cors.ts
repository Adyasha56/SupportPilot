import type { CorsOptions, CorsOptionsDelegate } from '@nestjs/common/interfaces/external/cors-options.interface';
import type { Request } from 'express';

/**
 * Milestone 5, Stage 1a, amendment A5 - ONE delegate function, not the `cors`
 * npm package added as a direct dependency. NestJS's `app.enableCors()`
 * accepts a `CorsOptionsDelegate<Request>` (a function receiving the request
 * and a callback), which is enough to express two different policies by
 * path without a second CORS middleware layer: any path under `/v1/chat`
 * (both `POST /v1/chat` itself and the new widget read endpoint,
 * `GET /v1/chat/conversations/:id/messages`, which lives under the same
 * prefix) gets the permissive, credential-less policy PROJECT.md section 6
 * requires (a widget is embedded on a page whose origin can't be known
 * ahead of time, and the public key itself - not Origin - is the real
 * boundary); every other path gets NO CORS headers at all, which is what
 * `{ origin: false }` does (confirmed against the underlying `cors` package
 * `enableCors` already pulls in transitively via @nestjs/platform-express -
 * `origin: false` adds no Access-Control-* headers whatsoever, it does not
 * merely deny the particular origin).
 *
 * `app.enableCors()` wires this in as Express-level middleware that runs
 * BEFORE Nest's own routing/guards - a browser's OPTIONS preflight is
 * therefore answered here, never reaching ApiKeyGuard at all (no API key is
 * required to preflight).
 */
const OPEN_CORS_PREFIX = '/v1/chat';

export interface CorsSettings {
  preflightMaxAgeSeconds: number;
}

function isOpenCorsPath(rawUrl: string | undefined): boolean {
  const path = (rawUrl ?? '').split('?')[0];
  return path === OPEN_CORS_PREFIX || path.startsWith(`${OPEN_CORS_PREFIX}/`);
}

export function buildCorsOptionsDelegate(settings: CorsSettings): CorsOptionsDelegate<Request> {
  return (req, callback) => {
    if (!isOpenCorsPath(req?.url)) {
      callback(null, { origin: false });
      return;
    }

    const options: CorsOptions = {
      origin: '*',
      credentials: false,
      methods: ['GET', 'POST', 'OPTIONS'],
      allowedHeaders: ['Authorization', 'Content-Type'],
      exposedHeaders: ['Retry-After'],
      maxAge: settings.preflightMaxAgeSeconds,
      optionsSuccessStatus: 204,
    };
    callback(null, options);
  };
}
