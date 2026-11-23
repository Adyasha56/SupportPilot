import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { TenantSettingsPatchRequest, TenantSettingsResponse } from '@supportpilot/shared';
import { AdminPrincipal } from '../admin-auth/admin-auth.guard';
import { VerifyPasswordService } from '../admin-auth/verify-password.service';
import { Tenant, TenantNotFoundError, TenantRepository, TenantSettingsPatch, TENANT_REPOSITORY } from '../db/tenant.repository';
import { TenantSettingsValidationError } from '../db/tenant-settings-validation';

export type TenantSettingsPutResult =
  | { kind: 'ok'; tenant: TenantSettingsResponse }
  | { kind: 'not_configured' }
  | { kind: 'no_settings_provided' }
  | { kind: 'key_principal_forbidden' }
  | { kind: 'step_up_required' }
  | { kind: 'invalid_password' }
  | { kind: 'hash_queue_full' }
  | { kind: 'confirmation_required' }
  | { kind: 'validation_failed'; message: string }
  | { kind: 'tenant_not_found' };

/** The two settings a session principal must step up for, and an API-key principal may never change at all - see this service's own doc comment. */
const RESTRICTED_FIELDS = ['refundCap', 'autoExecuteRefunds'] as const;

function toResponse(tenantId: string, tenant: Tenant): TenantSettingsResponse {
  return {
    tenantId,
    refundCap: tenant.refundCap!,
    approvalThreshold: tenant.approvalThreshold!,
    refundWindowDays: tenant.refundWindowDays!,
    autoExecuteRefunds: tenant.autoExecuteRefunds!,
    approvalExpiryDays: tenant.approvalExpiryDays!,
    ...(tenant.dailyRefundCountLimit !== undefined ? { dailyRefundCountLimit: tenant.dailyRefundCountLimit } : {}),
  };
}

function touchesRestrictedField(patch: TenantSettingsPatchRequest): boolean {
  return RESTRICTED_FIELDS.some((field) => patch[field] !== undefined);
}

function hasAnySetting(patch: TenantSettingsPatchRequest): boolean {
  return (
    patch.refundCap !== undefined ||
    patch.approvalThreshold !== undefined ||
    patch.refundWindowDays !== undefined ||
    patch.autoExecuteRefunds !== undefined ||
    patch.approvalExpiryDays !== undefined ||
    patch.dailyRefundCountLimit !== undefined
  );
}

function toSettingsPatch(patch: TenantSettingsPatchRequest): TenantSettingsPatch {
  return {
    refundCap: patch.refundCap,
    approvalThreshold: patch.approvalThreshold,
    refundWindowDays: patch.refundWindowDays,
    autoExecuteRefunds: patch.autoExecuteRefunds,
    approvalExpiryDays: patch.approvalExpiryDays,
    dailyRefundCountLimit: patch.dailyRefundCountLimit,
  };
}

/**
 * Stage 1c, item 3. `TenantRepository.updateSettings` stays exactly as
 * Milestone 4 built it (validates the effective merged settings, writes
 * its own `tenant_settings_changed` audit line) - this service adds the
 * admin-API-specific rules ON TOP: the restricted-field/step-up gate, and
 * a SECOND audit line naming the PRINCIPAL that made the change (the
 * repository's own log has no notion of "who called it" - it's shared
 * with the CLI script, which has no principal at all).
 */
@Injectable()
export class TenantSettingsAdminService {
  private readonly logger = new Logger(TenantSettingsAdminService.name);

  constructor(
    @Optional() @Inject(TENANT_REPOSITORY) private readonly tenantRepository: TenantRepository | undefined,
    private readonly verifyPasswordService: VerifyPasswordService,
  ) {}

  isConfigured(): boolean {
    return this.tenantRepository !== undefined;
  }

  async get(tenantId: string): Promise<TenantSettingsResponse | null> {
    const tenant = await this.tenantRepository!.findById(tenantId);
    return tenant ? toResponse(tenantId, tenant) : null;
  }

  async put(principal: AdminPrincipal, patch: TenantSettingsPatchRequest): Promise<TenantSettingsPutResult> {
    if (!this.tenantRepository) {
      return { kind: 'not_configured' };
    }
    if (!hasAnySetting(patch)) {
      return { kind: 'no_settings_provided' };
    }

    const before = await this.tenantRepository.findById(principal.tenantId);

    if (touchesRestrictedField(patch)) {
      // Structural, checked BEFORE any password is even looked at - an admin API key is refused
      // outright, same discipline VerifyPasswordService itself already applies for a non-session
      // principal (see that file's own doc comment).
      if (principal.kind !== 'session') {
        return { kind: 'key_principal_forbidden' };
      }

      const raisingCap = patch.refundCap !== undefined && (before?.refundCap === undefined || patch.refundCap > before.refundCap);
      const enablingAutoExecute = patch.autoExecuteRefunds === true;

      if (raisingCap || enablingAutoExecute) {
        if (patch.password === undefined) {
          return { kind: 'step_up_required' };
        }
        const verifyResult = await this.verifyPasswordService.verifyPassword(principal, patch.password);
        switch (verifyResult.kind) {
          case 'ok':
            break;
          case 'invalid_password':
          case 'not_session_principal':
            return { kind: 'invalid_password' };
          case 'queue_full':
            return { kind: 'hash_queue_full' };
          case 'not_configured':
            return { kind: 'not_configured' };
        }
      }
    }

    // Amendment N-c's CLI-level friction, now expressed as a request field - independent of the
    // dailyRefundCountLimit requirement TenantRepository.updateSettings itself enforces.
    if (patch.autoExecuteRefunds === true && patch.confirmAutoExecute !== true) {
      return { kind: 'confirmation_required' };
    }

    try {
      const after = await this.tenantRepository.updateSettings(principal.tenantId, toSettingsPatch(patch));
      this.audit(principal, before, after);
      return { kind: 'ok', tenant: toResponse(principal.tenantId, after) };
    } catch (err) {
      if (err instanceof TenantSettingsValidationError) {
        return { kind: 'validation_failed', message: err.message };
      }
      if (err instanceof TenantNotFoundError) {
        return { kind: 'tenant_not_found' };
      }
      throw err;
    }
  }

  /** Principal id, changed field names, and old/new values - never a password, never anything from the request body beyond the settings themselves. */
  private audit(principal: AdminPrincipal, before: Tenant | null, after: Tenant): void {
    const fields: (keyof Tenant)[] = ['refundCap', 'approvalThreshold', 'refundWindowDays', 'autoExecuteRefunds', 'approvalExpiryDays', 'dailyRefundCountLimit'];
    const changedKeys = fields.filter((key) => before?.[key] !== after[key]);
    if (changedKeys.length === 0) {
      return;
    }
    this.logger.log(
      JSON.stringify({
        event: 'tenant_settings_changed_via_admin_api',
        tenantId: principal.tenantId,
        principalKind: principal.kind,
        principalId: principal.principalId,
        changedKeys,
        before: Object.fromEntries(changedKeys.map((key) => [key, before?.[key]])),
        after: Object.fromEntries(changedKeys.map((key) => [key, after[key]])),
      }),
    );
  }
}
