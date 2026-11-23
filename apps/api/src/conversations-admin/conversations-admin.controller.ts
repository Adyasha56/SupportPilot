import { Controller, Get, NotFoundException, Param, Query, UseGuards } from '@nestjs/common';
import { ConversationDetailResponse, ConversationListQuerySchema, ConversationListResponse, GENERIC_ID_PATTERN } from '@supportpilot/shared';
import { AdminAuthGuard, AdminPrincipal } from '../admin-auth/admin-auth.guard';
import { CurrentAdminPrincipal } from '../admin-auth/current-admin-principal.decorator';
import { conversationsAdminHttpError } from './conversations-admin-http-error';
import { ConversationsAdminService } from './conversations-admin.service';

/**
 * Stage 1c, item 2 - no `@RequireScope` override, so `AdminAuthGuard`'s own
 * default minimum (`admin`) applies: a `secret`-scope key, already trusted
 * on policies/connectors, gets the exact same generic rejection a `public`
 * key does here - same as the existing `/v1/approvals*` surface.
 */
@Controller('v1/conversations')
@UseGuards(AdminAuthGuard)
export class ConversationsAdminController {
  constructor(private readonly service: ConversationsAdminService) {}

  @Get()
  async list(@CurrentAdminPrincipal() principal: AdminPrincipal, @Query() rawQuery: unknown): Promise<ConversationListResponse> {
    if (!this.service.isConfigured()) {
      throw conversationsAdminHttpError('NOT_CONFIGURED', 'The database is not configured.');
    }
    const parsed = ConversationListQuerySchema.safeParse(rawQuery);
    if (!parsed.success) {
      throw conversationsAdminHttpError('INVALID_REQUEST', 'The query parameters are invalid.');
    }
    return this.service.list(principal.tenantId, parsed.data);
  }

  @Get(':id')
  async getOne(@CurrentAdminPrincipal() principal: AdminPrincipal, @Param('id') id: string): Promise<ConversationDetailResponse> {
    if (!this.service.isConfigured()) {
      throw conversationsAdminHttpError('NOT_CONFIGURED', 'The database is not configured.');
    }
    // A malformed id is folded into the same 404 as "doesn't exist" - no format oracle, same rule GENERIC_ID_PATTERN already enforces for the widget polling endpoint.
    if (!GENERIC_ID_PATTERN.test(id)) {
      throw new NotFoundException();
    }
    const detail = await this.service.getDetail(principal.tenantId, id);
    if (!detail) {
      // Identical 404 whether the id belongs to another tenant or doesn't exist at all.
      throw new NotFoundException();
    }
    return detail;
  }
}
