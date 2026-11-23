import { Tenant, TenantNotFoundError, TenantRepository, TenantSettingsPatch } from '../tenant.repository';
import { validateEffectiveTenantSettings } from '../tenant-settings-validation';

/** Mirrors updateSettings' own "only keys actually present are changed" rule - an explicit `undefined` in patch must never overwrite an existing stored value. */
function removeUndefined(patch: TenantSettingsPatch): Partial<TenantSettingsPatch> {
  const result: Partial<TenantSettingsPatch> = {};
  for (const [key, value] of Object.entries(patch)) {
    if (value !== undefined) {
      (result as Record<string, unknown>)[key] = value;
    }
  }
  return result;
}

export class InMemoryTenantRepository implements TenantRepository {
  private readonly tenants = new Map<string, Tenant>();

  async findById(tenantId: string): Promise<Tenant | null> {
    return this.tenants.get(tenantId) ?? null;
  }

  async upsert(tenantId: string, name: string): Promise<Tenant> {
    const existing = this.tenants.get(tenantId);
    if (existing) {
      return existing;
    }
    const tenant: Tenant = { id: tenantId, name };
    this.tenants.set(tenantId, tenant);
    return tenant;
  }

  /** Mirrors MongooseTenantRepository.updateSettings' own "validate the EFFECTIVE merged settings" rule (tenant-settings-validation.ts) - not just this call's own patch in isolation. */
  async updateSettings(tenantId: string, patch: TenantSettingsPatch): Promise<Tenant> {
    const existing = this.tenants.get(tenantId);
    if (!existing) {
      throw new TenantNotFoundError(tenantId);
    }
    const updated: Tenant = { ...existing, ...removeUndefined(patch) };
    validateEffectiveTenantSettings(updated);
    this.tenants.set(tenantId, updated);
    return updated;
  }

  /** Test-only convenience - a real admin console (Milestone 5) would be the only other writer of this field. */
  setAllowedOrigins(tenantId: string, allowedOrigins: string[]): void {
    const existing = this.tenants.get(tenantId);
    this.tenants.set(tenantId, { id: tenantId, name: existing?.name ?? tenantId, allowedOrigins });
  }

  /** Test-only convenience, mirroring setAllowedOrigins above - lets a test set refundCap/approvalThreshold/etc. without going through updateSettings' TenantNotFoundError semantics. */
  setSettings(tenantId: string, patch: TenantSettingsPatch): void {
    const existing = this.tenants.get(tenantId);
    const updated: Tenant = { id: tenantId, name: existing?.name ?? tenantId, ...existing, ...patch };
    this.tenants.set(tenantId, updated);
  }
}
