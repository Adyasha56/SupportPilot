import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { AuthenticatedRequest, TENANT_REQUEST_KEY } from './api-key.guard';

/** The ONLY sanctioned way for a controller to read the authenticated tenant - never the body, query, or params. */
export const CurrentTenant = createParamDecorator((_data: unknown, ctx: ExecutionContext): string => {
  const request = ctx.switchToHttp().getRequest<AuthenticatedRequest>();
  return request[TENANT_REQUEST_KEY];
});
