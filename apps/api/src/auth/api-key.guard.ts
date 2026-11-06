import {
  CanActivate,
  ExecutionContext,
  HttpException,
  Inject,
  Injectable,
  Logger,
  Optional,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request, Response } from 'express';
import { API_KEY_REPOSITORY, ApiKeyRepository } from '../db/api-key.repository';
import { ApiKeyScope } from '../db/schemas/api-key.schema';
import { TENANT_REPOSITORY, TenantRepository } from '../db/tenant.repository';
import { hashApiKey, verifyApiKeyHash } from './api-key.service';
import { FailedAttemptLimiter } from './failed-attempt-limiter';
import { RateLimiter, RateLimiterSettings } from './rate-limiter';
import { REQUIRE_SCOPE_KEY } from './require-scope.decorator';

export const TENANT_REQUEST_KEY = 'tenantId';
export const MATCHED_SCOPE_REQUEST_KEY = 'matchedScope';
export const API_KEY_ID_REQUEST_KEY = 'apiKeyId';

const GENERIC_AUTH_ERROR = 'Unauthorized';

export type AuthenticatedRequest = Request & {
  [TENANT_REQUEST_KEY]: string;
  /** The scope that actually authorized this request - see scopeSatisfies's own doc comment for why this can differ from the route's @RequireScope. */
  [MATCHED_SCOPE_REQUEST_KEY]: ApiKeyScope;
  [API_KEY_ID_REQUEST_KEY]: string;
};

/**
 * Stage 3 - injectable so tests can use tiny thresholds instead of waiting
 * out real, production-sized windows. A Symbol token (not the RateLimiter
 * class itself) because the guard needs TWO independently-configured
 * instances (IP-keyed, key-keyed) and Nest's reflection-based DI can't
 * distinguish two constructor parameters of the identical class type.
 * Omitted entirely (the common case - no provider registered) falls back
 * to DEFAULT_API_KEY_GUARD_SETTINGS below, the same "@Optional(), fall back
 * to a sensible default" shape as every other limiter in this file.
 */
export interface ApiKeyGuardSettings {
  ipRateLimit: RateLimiterSettings;
  keyRateLimit: RateLimiterSettings;
}
export const API_KEY_GUARD_SETTINGS = Symbol('API_KEY_GUARD_SETTINGS');
export const DEFAULT_API_KEY_GUARD_SETTINGS: ApiKeyGuardSettings = {
  ipRateLimit: { maxRequests: 300, windowMs: 60_000, maxEntries: 5000 },
  keyRateLimit: { maxRequests: 120, windowMs: 60_000, maxEntries: 5000 },
};

/**
 * Missing header, malformed header, unknown key, revoked key, and
 * missing-required-scope ALL produce the exact same generic 401 - nothing
 * in the response distinguishes them, so an attacker learns nothing about
 * which part of their guess was wrong. Tenant is resolved from the key
 * only and attached to the request; no controller reads tenantId from the
 * body, query, or params.
 *
 * Order of operations (Stage 3): per-IP rate limiter (429, before any
 * database read) -> existing failed-attempt limiter (401, unchanged) ->
 * header parse -> key lookup (hash, timing-safe compare) -> per-KEY rate
 * limiter (429) -> scope check (401) -> the Origin "speed bump" (never
 * blocks). The per-IP limiter runs first specifically so a request flood
 * from one source is rejected before it can ever cause a database read,
 * regardless of whether the keys it's guessing are real.
 */
@Injectable()
export class ApiKeyGuard implements CanActivate {
  private readonly logger = new Logger(ApiKeyGuard.name);
  private readonly limiter = new FailedAttemptLimiter();
  private readonly ipRateLimiter: RateLimiter;
  private readonly keyRateLimiter: RateLimiter;

  constructor(
    @Optional() @Inject(API_KEY_REPOSITORY) private readonly repository: ApiKeyRepository | undefined,
    private readonly reflector: Reflector,
    @Optional() @Inject(TENANT_REPOSITORY) private readonly tenantRepository: TenantRepository | undefined,
    @Optional() @Inject(API_KEY_GUARD_SETTINGS) settings?: ApiKeyGuardSettings,
  ) {
    const resolved = settings ?? DEFAULT_API_KEY_GUARD_SETTINGS;
    const clock = () => new Date();
    this.ipRateLimiter = new RateLimiter(resolved.ipRateLimit, clock);
    this.keyRateLimiter = new RateLimiter(resolved.keyRateLimit, clock);
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (!this.repository) {
      // No database configured at all - every key lookup is impossible,
      // not just this one's. 503 (not the generic 401) because this is a
      // server configuration problem, never a bad credential - it must
      // never be confused with "the app is fine, your key is wrong."
      throw new ServiceUnavailableException({
        statusCode: 503,
        code: 'NOT_CONFIGURED',
        message: 'The database is not configured.',
      });
    }

    const request = context.switchToHttp().getRequest<Request>();
    const response = context.switchToHttp().getResponse<Response>();
    const clientKey = request.ip ?? request.socket.remoteAddress ?? 'unknown';

    // Stage 3 - the per-IP RATE limiter: runs before anything else that
    // touches the database, including the key lookup. Distinct from the
    // FailedAttemptLimiter below - this one counts every request
    // regardless of outcome, not just failures, and rejects with 429/
    // Retry-After rather than the generic 401.
    const ipDecision = this.ipRateLimiter.tryConsume(clientKey);
    if (!ipDecision.allowed) {
      this.failTooManyRequests(response, ipDecision.retryAfterMs);
    }

    if (this.limiter.isBlocked(clientKey)) {
      throw new UnauthorizedException(GENERIC_AUTH_ERROR);
    }

    const header = request.headers.authorization;
    if (!header || !header.startsWith('Bearer ')) {
      this.fail(clientKey);
    }

    const rawKey = (header as string).slice('Bearer '.length);
    const candidateHash = hashApiKey(rawKey);
    const record = await this.repository.findByHash(candidateHash);

    if (!record || !verifyApiKeyHash(candidateHash, record.hash) || record.revokedAt) {
      this.fail(clientKey);
    }

    // Stage 3 - the per-KEY RATE limiter, keyed by the now-resolved key's
    // own id (never the raw key or its hash) - only reached once the key
    // has already been proven valid, so an unknown/guessed key is never
    // the thing being rate-limited here (the IP limiter above already
    // covers that case).
    const keyDecision = this.keyRateLimiter.tryConsume(record!.id);
    if (!keyDecision.allowed) {
      this.failTooManyRequests(response, keyDecision.retryAfterMs);
    }

    // getAllAndOverride checks the handler (method) first, falling back to
    // the class - @RequireScope() works whether applied to one route or to
    // an entire controller (e.g. PoliciesController applies it once, at the
    // class level). A plain reflector.get(key, context.getHandler()) would
    // silently miss class-level metadata entirely.
    const requiredScope = this.reflector.getAllAndOverride<ApiKeyScope | undefined>(REQUIRE_SCOPE_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (requiredScope && !scopeSatisfies(record!.scopes, requiredScope)) {
      this.fail(clientKey);
    }

    this.limiter.recordSuccess(clientKey);

    // Stage 3 - secret is a strict superset of public (see scopeSatisfies),
    // so matchedScope reports the key's OWN highest capability, not merely
    // "whatever the route happened to require." A later stage (e.g. the
    // chat controller deciding whether to honor a request-supplied
    // customerRef) needs to know the key is REALLY secret-scope, even on a
    // route whose own requirement is only @RequireScope('public').
    const matchedScope: ApiKeyScope = record!.scopes.includes('secret') ? 'secret' : 'public';
    (request as AuthenticatedRequest)[TENANT_REQUEST_KEY] = record!.tenantId;
    (request as AuthenticatedRequest)[MATCHED_SCOPE_REQUEST_KEY] = matchedScope;
    (request as AuthenticatedRequest)[API_KEY_ID_REQUEST_KEY] = record!.id;

    if (matchedScope === 'public') {
      await this.checkOriginSpeedBump(record!.tenantId, request);
    }

    return true;
  }

  /**
   * NOT a security boundary - documented here and in PROJECT.md section 3:
   * a widget page can always be proxied, screenshotted, or have its
   * `publicKey` copied elsewhere, so an Origin mismatch can never be relied
   * on to actually stop a request. This exists purely as an operator
   * signal ("is traffic arriving from somewhere other than the configured
   * embed site") - it NEVER blocks, throws, or slows down the request, and
   * it never logs the raw header value, only whether it matched and
   * whether an Origin was present at all. A tenant with no allowedOrigins
   * configured skips this entirely - there is nothing to compare against.
   */
  private async checkOriginSpeedBump(tenantId: string, request: Request): Promise<void> {
    if (!this.tenantRepository) {
      return;
    }
    try {
      const tenant = await this.tenantRepository.findById(tenantId);
      const allowedOrigins = tenant?.allowedOrigins;
      if (!allowedOrigins || allowedOrigins.length === 0) {
        return;
      }
      const origin = request.headers.origin;
      const matched = typeof origin === 'string' && allowedOrigins.includes(origin);
      if (!matched) {
        this.logger.warn(
          JSON.stringify({ event: 'public_key_origin_mismatch', tenantId, originPresent: typeof origin === 'string' }),
        );
      }
    } catch (err) {
      // Never let this advisory-only check affect the request - including
      // on its own failure, e.g. the tenant lookup itself erroring.
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(JSON.stringify({ event: 'origin_speed_bump_check_failed', tenantId, error: message }));
    }
  }

  private fail(clientKey: string): never {
    this.limiter.recordFailure(clientKey);
    throw new UnauthorizedException(GENERIC_AUTH_ERROR);
  }

  private failTooManyRequests(response: Response, retryAfterMs: number): never {
    const retryAfterSeconds = Math.ceil(retryAfterMs / 1000);
    response.setHeader('Retry-After', String(retryAfterSeconds));
    throw new HttpException(
      { statusCode: 429, code: 'RATE_LIMITED', message: 'Too many requests.', retryAfterSeconds },
      429,
    );
  }
}

/**
 * `secret` is a strict superset of `public` - a secret-scope (server-to-
 * server) key is trusted for everything a public (widget) key is, plus
 * everything else (PROJECT.md section 6: "a separate secretKey... authorizes
 * all other /v1/* endpoints", which includes the public-only /v1/chat
 * route - Stage 4 amendment I). The reverse never holds: a public-scope key
 * must never satisfy a route that specifically requires secret, however it
 * satisfies its OWN scope's requirement as before. No requirement
 * (`required` undefined) always passes, unchanged from before this stage.
 */
function scopeSatisfies(keyScopes: ApiKeyScope[], required: ApiKeyScope): boolean {
  if (keyScopes.includes('secret')) {
    return true;
  }
  return keyScopes.includes(required);
}
