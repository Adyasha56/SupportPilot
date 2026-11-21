import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { ADMIN_PRINCIPAL_REQUEST_KEY, AdminAuthenticatedRequest, AdminPrincipal } from './admin-auth.guard';

export const CurrentAdminPrincipal = createParamDecorator((_data: unknown, ctx: ExecutionContext): AdminPrincipal => {
  const request = ctx.switchToHttp().getRequest<AdminAuthenticatedRequest>();
  return request[ADMIN_PRINCIPAL_REQUEST_KEY];
});
