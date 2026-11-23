import { CanActivate, ExecutionContext, HttpException, Inject, Injectable, Optional, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request, Response } from 'express';
import { decidedByForAdminSession, decidedByForApiKey } from '@supportpilot/shared';
import { API_KEY_REPOSITORY, ApiKeyRepository } from '../db/api-key.repository';
import { ApiKeyScope } from '../db/schemas/api-key.schema';
import { ADMIN_SESSION_REPOSITORY, AdminSessionRepository } from '../db/admin-session.repository';
import { hashApiKey, verifyApiKeyHash } from '../auth/api-key.service';
import { RateLimiter } from '../auth/rate-limiter';
import { REQUIRE_SCOPE_KEY } from '../auth/require-scope.decorator';
import { scopeSatisfies } from '../auth/scope-rank';
import { csrfTokensMatch, hashSessionToken, tokensMatch } from './session-token';
import { parseCookieHeader, readSessionCookieValue } from './cookie-utils';
import { checkOriginForStateChange } from './origin-guard';
import { ADMIN_AUTH_SETTINGS } from './admin-auth-settings.provider';
import { AdminAuthSettings } from './admin-auth.settings';

/**
 * Stage 1c, item 1 - the default MINIMUM scope for an admin-surface route
 * that declares no `@RequireScope` of its own. This is deliberately the
 * STRICTEST rank (`admin`), not the weakest - every route this guard
 * protected before this stage (approvals, admin session/logout) required
 * `admin` outright, and a route that forgets to annotate itself must fail
 * closed at the strictest level, never silently open up to `secret`.
 * `PoliciesController` (Stage 1c item 1) is the one place that opts into
 * the weaker `secret` minimum, explicitly, via `@RequireScope('secret')`.
 */
const DEFAULT_MINIMUM_SCOPE: ApiKeyScope = 'admin';

export const ADMIN_PRINCIPAL_REQUEST_KEY = 'adminPrincipal';

export type AdminPrincipalKind = 'api_key' | 'session';

export interface AdminPrincipal {
  tenantId: string;
  principalId: string;
  kind: AdminPrincipalKind;
  /** Only present for kind: 'session' - the CSRF token this request must echo back on a non-GET request, and the session row id (for logout). */
  sessionId?: string;
  csrfToken?: string;
}

export type AdminAuthenticatedRequest = Request & { [ADMIN_PRINCIPAL_REQUEST_KEY]: AdminPrincipal };

const GENERIC_AUTH_ERROR = 'Unauthorized';
const CSRF_HEADER_NAME = 'x-csrf-token';

/**
 * Milestone 5, Stage 1b, item 6 - ONE guard, TWO mutually exclusive
 * authentication paths, NEVER mixed: if `Authorization` is present, ONLY
 * the admin-scoped API-key path is considered (a cookie present on the
 * SAME request is simply ignored) - if it's absent, ONLY the cookie
 * session path is considered. This is a deliberate, structural choice:
 * accepting EITHER on a request that happens to carry both would make the
 * two schemes' own security properties interact in ways neither was
 * designed for (e.g. CSRF only makes sense for the ambient-credential
 * cookie scheme, never for a bearer header an attacker's browser can't
 * silently attach).
 *
 * CSRF + the Origin/Sec-Fetch-Site check (origin-guard.ts) apply ONLY to
 * the session path, and ONLY on a non-GET request - a bearer API key is
 * never subject to CSRF (nothing ambient to forge), and a GET is assumed
 * side-effect-free (the existing convention every other read-only route in
 * this project already relies on implicitly).
 *
 * Stage 1c, item 1 - a MINIMUM scope per route, read via the SAME
 * `@RequireScope`/`REQUIRE_SCOPE_KEY` metadata `ApiKeyGuard` already uses
 * (never a second decorator - a route's own required scope should mean
 * the same thing regardless of which guard protects it, so a future move
 * between the two guards is never a silent behavior change). A KEY
 * principal is checked against it with the exact same rank comparison
 * (`scopeSatisfies`, `../auth/scope-rank.ts`) `ApiKeyGuard` uses - `admin`
 * satisfies a `secret` requirement, never the reverse. A SESSION principal
 * always satisfies every requirement outright, with no comparison at all:
 * a cookie session only ever exists because a real admin password was
 * verified at login (admin-login.service.ts), so it counts as the
 * strongest scope unconditionally - there is no weaker "session scope" to
 * compare against a route's requirement. Nothing changes for an existing
 * `secret`-scope key calling a route that still requires `admin` (the
 * route-coverage test's own "nothing changes" case, Stage 1c item 1): it
 * gets the exact same generic 401 it always did.
 *
 * Stage 1c, item 5 - a per-PRINCIPAL rate limit, checked AFTER
 * authentication succeeds, on EVERY route this guard protects (never
 * opt-in per controller) - same `RateLimiter` class `ApiKeyGuard` already
 * uses for its own per-key bucket, keyed by the SAME `decidedByForApiKey`/
 * `decidedByForAdminSession` format the approvals decision audit trail
 * already uses, so a session principal and an API-key principal never
 * share a budget just because they might coincidentally carry the same
 * `principalId`. This is deliberately separate from (and in addition to)
 * `ApprovalsController`'s own, narrower per-decision limiter
 * (approval-decision-rate-limiter.provider.ts) - that one specifically
 * throttles the single highest-stakes action (a decision), this one is
 * the general ceiling across every admin route a principal can call at
 * all.
 */
@Injectable()
export class AdminAuthGuard implements CanActivate {
  private readonly principalRateLimiter: RateLimiter;

  constructor(
    @Optional() @Inject(API_KEY_REPOSITORY) private readonly apiKeyRepository: ApiKeyRepository | undefined,
    @Optional() @Inject(ADMIN_SESSION_REPOSITORY) private readonly sessionRepository: AdminSessionRepository | undefined,
    @Inject(ADMIN_AUTH_SETTINGS) private readonly settings: AdminAuthSettings,
    private readonly reflector: Reflector,
    @Optional() private readonly clock: () => Date = () => new Date(),
  ) {
    this.principalRateLimiter = new RateLimiter(
      {
        maxRequests: settings.principalRateLimitMaxRequests,
        windowMs: settings.principalRateLimitWindowMs,
        maxEntries: settings.principalRateLimitMaxEntries,
      },
      this.clock,
    );
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request>();

    // getAllAndOverride checks the handler (method) first, falling back to
    // the class - same reason ApiKeyGuard reads it this way (a route can
    // override its controller's own class-level @RequireScope).
    const requiredScope = this.reflector.getAllAndOverride<ApiKeyScope | undefined>(REQUIRE_SCOPE_KEY, [
      context.getHandler(),
      context.getClass(),
    ]) ?? DEFAULT_MINIMUM_SCOPE;

    // TEMPORARY DIAGNOSTIC (remove once the connectors-admin 401 is root-caused) -
    // console.error so it surfaces regardless of Logger configuration.
    console.error(
      'DEBUG_ADMIN_AUTH_GUARD',
      JSON.stringify({
        url: request.url,
        method: request.method,
        hasAuthHeader: Boolean(request.headers.authorization),
        requiredScope,
        hasApiKeyRepository: Boolean(this.apiKeyRepository),
        hasSessionRepository: Boolean(this.sessionRepository),
        className: context.getClass()?.name,
        handlerName: context.getHandler()?.name,
      }),
    );

    const authorizationHeader = request.headers.authorization;
    let principal: AdminPrincipal;
    try {
      principal = authorizationHeader
        ? await this.authenticateApiKey(authorizationHeader, requiredScope)
        : await this.authenticateSession(request);
    } catch (err) {
      console.error(
        'DEBUG_ADMIN_AUTH_GUARD_FAIL',
        JSON.stringify({ url: request.url, errType: err instanceof Error ? err.constructor.name : typeof err, errMessage: err instanceof Error ? err.message : String(err) }),
      );
      throw err;
    }

    this.checkPrincipalRateLimit(principal, context);

    (request as AdminAuthenticatedRequest)[ADMIN_PRINCIPAL_REQUEST_KEY] = principal;
    return true;
  }

  private checkPrincipalRateLimit(principal: AdminPrincipal, context: ExecutionContext): void {
    const key = principal.kind === 'api_key' ? decidedByForApiKey(principal.principalId) : decidedByForAdminSession(principal.principalId);
    const decision = this.principalRateLimiter.tryConsume(key);
    if (!decision.allowed) {
      const response = context.switchToHttp().getResponse<Response>();
      const retryAfterSeconds = Math.ceil(decision.retryAfterMs / 1000);
      response.setHeader('Retry-After', String(retryAfterSeconds));
      throw new HttpException({ statusCode: 429, code: 'RATE_LIMITED', message: 'Too many requests.', retryAfterSeconds }, 429);
    }
  }

  private async authenticateApiKey(authorizationHeader: string, requiredScope: ApiKeyScope): Promise<AdminPrincipal> {
    if (!this.apiKeyRepository) {
      this.fail();
    }
    if (!authorizationHeader.startsWith('Bearer ')) {
      this.fail();
    }
    const rawKey = authorizationHeader.slice('Bearer '.length);
    const candidateHash = hashApiKey(rawKey);
    const record = await this.apiKeyRepository!.findByHash(candidateHash);
    console.error(
      'DEBUG_ADMIN_AUTH_GUARD_KEY_LOOKUP',
      JSON.stringify({
        found: Boolean(record),
        scopes: record?.scopes,
        revokedAt: record?.revokedAt,
        requiredScope,
        verifies: record ? verifyApiKeyHash(candidateHash, record.hash) : undefined,
        scopeSatisfiesResult: record ? scopeSatisfies(record.scopes, requiredScope) : undefined,
      }),
    );
    if (!record || !verifyApiKeyHash(candidateHash, record.hash) || record.revokedAt || !scopeSatisfies(record.scopes, requiredScope)) {
      this.fail();
    }

    return { tenantId: record!.tenantId, principalId: record!.id, kind: 'api_key' };
  }

  private async authenticateSession(request: Request): Promise<AdminPrincipal> {
    if (!this.sessionRepository) {
      this.fail();
    }
    const cookies = parseCookieHeader(request.headers.cookie);
    const rawToken = readSessionCookieValue(cookies);
    console.error(
      'DEBUG_ADMIN_AUTH_GUARD_SESSION_COOKIE',
      JSON.stringify({ rawCookieHeader: request.headers.cookie, parsedCookieNames: Object.keys(cookies), hasRawToken: Boolean(rawToken) }),
    );
    if (!rawToken) {
      this.fail();
    }

    const tokenHash = hashSessionToken(rawToken!);
    const session = await this.sessionRepository!.findByTokenHash(tokenHash);
    console.error('DEBUG_ADMIN_AUTH_GUARD_SESSION_LOOKUP', JSON.stringify({ found: Boolean(session) }));
    if (!session || !tokensMatch(tokenHash, session.tokenHash)) {
      this.fail();
    }

    const now = this.clock();
    if (now.getTime() >= session!.absoluteExpiresAt.getTime()) {
      this.fail();
    }
    const idleDeadline = session!.lastSeenAt.getTime() + session!.idleTimeoutMs;
    if (now.getTime() >= idleDeadline) {
      this.fail();
    }

    if (request.method !== 'GET') {
      const originCheck = checkOriginForStateChange(
        { secFetchSite: request.headers['sec-fetch-site'] as string | undefined, origin: request.headers.origin },
        this.settings.allowedOrigins,
      );
      if (!originCheck.ok) {
        this.fail();
      }
      const presentedCsrf = request.headers[CSRF_HEADER_NAME] as string | undefined;
      if (!presentedCsrf || !csrfTokensMatch(presentedCsrf, session!.csrfToken)) {
        this.fail();
      }
    }

    // item 5 - "at most once per minute", never on every request.
    if (now.getTime() - session!.lastSeenAt.getTime() >= this.settings.sessionLastSeenWriteIntervalMs) {
      await this.sessionRepository!.updateLastSeenAt(session!.id, now);
    }

    return { tenantId: session!.tenantId, principalId: session!.principalId, kind: 'session', sessionId: session!.id, csrfToken: session!.csrfToken };
  }

  private fail(): never {
    throw new UnauthorizedException(GENERIC_AUTH_ERROR);
  }
}
