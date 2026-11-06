import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { ApiKeyScope } from '../db/schemas/api-key.schema';
import { API_KEY_ID_REQUEST_KEY, AuthenticatedRequest, MATCHED_SCOPE_REQUEST_KEY } from './api-key.guard';

/** The authenticating key's own highest scope (secret is a superset of public - see api-key.guard.ts's scopeSatisfies), never the route's own @RequireScope value. */
export const CurrentApiKeyScope = createParamDecorator((_data: unknown, ctx: ExecutionContext): ApiKeyScope => {
  const request = ctx.switchToHttp().getRequest<AuthenticatedRequest>();
  return request[MATCHED_SCOPE_REQUEST_KEY];
});

/** The authenticated ApiKey document's own id - never the raw key or its hash, neither of which this request ever has access to past the guard. */
export const CurrentApiKeyId = createParamDecorator((_data: unknown, ctx: ExecutionContext): string => {
  const request = ctx.switchToHttp().getRequest<AuthenticatedRequest>();
  return request[API_KEY_ID_REQUEST_KEY];
});
