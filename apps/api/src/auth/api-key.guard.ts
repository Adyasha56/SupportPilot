import { CanActivate, ExecutionContext, Inject, Injectable, Optional, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { API_KEY_REPOSITORY, ApiKeyRepository } from '../db/api-key.repository';
import { ApiKeyScope } from '../db/schemas/api-key.schema';
import { hashApiKey, verifyApiKeyHash } from './api-key.service';
import { FailedAttemptLimiter } from './failed-attempt-limiter';
import { REQUIRE_SCOPE_KEY } from './require-scope.decorator';

export const TENANT_REQUEST_KEY = 'tenantId';

const GENERIC_AUTH_ERROR = 'Unauthorized';

export type AuthenticatedRequest = Request & { [TENANT_REQUEST_KEY]: string };

/**
 * Missing header, malformed header, unknown key, revoked key, and
 * missing-required-scope ALL produce the exact same generic 401 - nothing
 * in the response distinguishes them, so an attacker learns nothing about
 * which part of their guess was wrong. Tenant is resolved from the key
 * only and attached to the request; no controller reads tenantId from the
 * body, query, or params.
 */
@Injectable()
export class ApiKeyGuard implements CanActivate {
  private readonly limiter = new FailedAttemptLimiter();

  constructor(
    @Optional() @Inject(API_KEY_REPOSITORY) private readonly repository: ApiKeyRepository | undefined,
    private readonly reflector: Reflector,
  ) {}

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
    const clientKey = request.ip ?? request.socket.remoteAddress ?? 'unknown';

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

    // getAllAndOverride checks the handler (method) first, falling back to
    // the class - @RequireScope() works whether applied to one route or to
    // an entire controller (e.g. PoliciesController applies it once, at the
    // class level). A plain reflector.get(key, context.getHandler()) would
    // silently miss class-level metadata entirely.
    const requiredScope = this.reflector.getAllAndOverride<ApiKeyScope | undefined>(REQUIRE_SCOPE_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (requiredScope && !record!.scopes.includes(requiredScope)) {
      this.fail(clientKey);
    }

    this.limiter.recordSuccess(clientKey);
    (request as AuthenticatedRequest)[TENANT_REQUEST_KEY] = record!.tenantId;
    return true;
  }

  private fail(clientKey: string): never {
    this.limiter.recordFailure(clientKey);
    throw new UnauthorizedException(GENERIC_AUTH_ERROR);
  }
}
