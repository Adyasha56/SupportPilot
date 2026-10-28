import { Tenant, TenantRepository } from '../tenant.repository';

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
}
