import { CanActivate, ExecutionContext, Inject, Injectable, UnauthorizedException } from '@nestjs/common';
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
    @Inject(API_KEY_REPOSITORY) private readonly repository: ApiKeyRepository,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
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

    const requiredScope = this.reflector.get<ApiKeyScope | undefined>(
      REQUIRE_SCOPE_KEY,
      context.getHandler(),
    );
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
