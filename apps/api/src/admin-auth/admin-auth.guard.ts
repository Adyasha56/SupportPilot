import { CanActivate, ExecutionContext, Inject, Injectable, Optional, UnauthorizedException } from '@nestjs/common';
import type { Request } from 'express';
import { API_KEY_REPOSITORY, ApiKeyRepository } from '../db/api-key.repository';
import { ADMIN_SESSION_REPOSITORY, AdminSessionRepository } from '../db/admin-session.repository';
import { hashApiKey, verifyApiKeyHash } from '../auth/api-key.service';
import { csrfTokensMatch, hashSessionToken, tokensMatch } from './session-token';
import { parseCookieHeader, readSessionCookieValue } from './cookie-utils';
import { checkOriginForStateChange } from './origin-guard';
import { ADMIN_AUTH_SETTINGS } from './admin-auth-settings.provider';
import { AdminAuthSettings } from './admin-auth.settings';

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
 */
@Injectable()
export class AdminAuthGuard implements CanActivate {
  constructor(
    @Optional() @Inject(API_KEY_REPOSITORY) private readonly apiKeyRepository: ApiKeyRepository | undefined,
    @Optional() @Inject(ADMIN_SESSION_REPOSITORY) private readonly sessionRepository: AdminSessionRepository | undefined,
    @Inject(ADMIN_AUTH_SETTINGS) private readonly settings: AdminAuthSettings,
    @Optional() private readonly clock: () => Date = () => new Date(),
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request>();

    const authorizationHeader = request.headers.authorization;
    if (authorizationHeader) {
      return this.authenticateApiKey(authorizationHeader, request);
    }
    return this.authenticateSession(request);
  }

  private async authenticateApiKey(authorizationHeader: string, request: Request): Promise<boolean> {
    if (!this.apiKeyRepository) {
      this.fail();
    }
    if (!authorizationHeader.startsWith('Bearer ')) {
      this.fail();
    }
    const rawKey = authorizationHeader.slice('Bearer '.length);
    const candidateHash = hashApiKey(rawKey);
    const record = await this.apiKeyRepository!.findByHash(candidateHash);
    if (!record || !verifyApiKeyHash(candidateHash, record.hash) || record.revokedAt || !record.scopes.includes('admin')) {
      this.fail();
    }

    (request as AdminAuthenticatedRequest)[ADMIN_PRINCIPAL_REQUEST_KEY] = {
      tenantId: record!.tenantId,
      principalId: record!.id,
      kind: 'api_key',
    };
    return true;
  }

  private async authenticateSession(request: Request): Promise<boolean> {
    if (!this.sessionRepository) {
      this.fail();
    }
    const cookies = parseCookieHeader(request.headers.cookie);
    const rawToken = readSessionCookieValue(cookies);
    if (!rawToken) {
      this.fail();
    }

    const tokenHash = hashSessionToken(rawToken!);
    const session = await this.sessionRepository!.findByTokenHash(tokenHash);
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

    (request as AdminAuthenticatedRequest)[ADMIN_PRINCIPAL_REQUEST_KEY] = {
      tenantId: session!.tenantId,
      principalId: session!.principalId,
      kind: 'session',
      sessionId: session!.id,
      csrfToken: session!.csrfToken,
    };
    return true;
  }

  private fail(): never {
    throw new UnauthorizedException(GENERIC_AUTH_ERROR);
  }
}
