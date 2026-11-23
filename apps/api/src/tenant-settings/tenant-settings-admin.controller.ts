import { Body, Controller, Get, Put, UseGuards } from '@nestjs/common';
import { TenantSettingsPatchRequestSchema, TenantSettingsResponse } from '@supportpilot/shared';
import { AdminAuthGuard, AdminPrincipal } from '../admin-auth/admin-auth.guard';
import { CurrentAdminPrincipal } from '../admin-auth/current-admin-principal.decorator';
import { tenantSettingsHttpError } from './tenant-settings-http-error';
import { TenantSettingsAdminService } from './tenant-settings-admin.service';

/**
 * Stage 1c, item 3. No `@RequireScope` override - `AdminAuthGuard`'s own
 * default minimum (`admin`) applies to both routes, same as
 * `/v1/approvals*` and `/v1/conversations*`. The STEP-UP rule for
 * `refundCap`/`autoExecuteRefunds` is enforced inside
 * `TenantSettingsAdminService.put`, never here - this controller only maps
 * the service's typed result to an HTTP response, the same split every
 * other controller in this project already follows.
 */
@Controller('v1/tenant/settings')
@UseGuards(AdminAuthGuard)
export class TenantSettingsAdminController {
  constructor(private readonly service: TenantSettingsAdminService) {}

  @Get()
  async get(@CurrentAdminPrincipal() principal: AdminPrincipal): Promise<TenantSettingsResponse> {
    if (!this.service.isConfigured()) {
      throw tenantSettingsHttpError('NOT_CONFIGURED', 'The database is not configured.');
    }
    const settings = await this.service.get(principal.tenantId);
    if (!settings) {
      throw tenantSettingsHttpError('TENANT_NOT_FOUND', 'This tenant has no settings on record.');
    }
    return settings;
  }

  @Put()
  async put(@CurrentAdminPrincipal() principal: AdminPrincipal, @Body() rawBody: unknown): Promise<TenantSettingsResponse> {
    if (!this.service.isConfigured()) {
      throw tenantSettingsHttpError('NOT_CONFIGURED', 'The database is not configured.');
    }
    const parsed = TenantSettingsPatchRequestSchema.safeParse(rawBody);
    if (!parsed.success) {
      throw tenantSettingsHttpError('INVALID_REQUEST', 'The request body is invalid.');
    }

    const result = await this.service.put(principal, parsed.data);
    switch (result.kind) {
      case 'ok':
        return result.tenant;
      case 'not_configured':
        throw tenantSettingsHttpError('NOT_CONFIGURED', 'The database is not configured.');
      case 'no_settings_provided':
        throw tenantSettingsHttpError('INVALID_REQUEST', 'At least one setting must be provided.');
      case 'key_principal_forbidden':
        throw tenantSettingsHttpError('KEY_PRINCIPAL_CANNOT_CHANGE_FIELD', 'An admin API key cannot change refundCap or autoExecuteRefunds. Use a session.');
      case 'step_up_required':
        throw tenantSettingsHttpError('STEP_UP_REQUIRED', 'Raising refundCap or enabling autoExecuteRefunds requires a password.');
      case 'invalid_password':
        throw tenantSettingsHttpError('INVALID_PASSWORD', 'The password is incorrect.');
      case 'hash_queue_full':
        throw tenantSettingsHttpError('HASH_QUEUE_FULL', 'The server is busy. Please try again shortly.');
      case 'confirmation_required':
        throw tenantSettingsHttpError('CONFIRMATION_REQUIRED', 'Enabling autoExecuteRefunds requires confirmAutoExecute: true in the same call.');
      case 'validation_failed':
        throw tenantSettingsHttpError('VALIDATION_FAILED', result.message);
      case 'tenant_not_found':
        throw tenantSettingsHttpError('TENANT_NOT_FOUND', 'This tenant has no settings on record.');
    }
  }
}
