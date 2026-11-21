import { AdminCredentialEmailInUseError, AdminCredentialRecord, AdminCredentialRepository } from '../admin-credential.repository';

export class InMemoryAdminCredentialRepository implements AdminCredentialRepository {
  private readonly byTenantId = new Map<string, AdminCredentialRecord>();

  async findByEmail(email: string): Promise<AdminCredentialRecord | null> {
    for (const record of this.byTenantId.values()) {
      if (record.email === email) {
        return record;
      }
    }
    return null;
  }

  async findByTenantId(tenantId: string): Promise<AdminCredentialRecord | null> {
    return this.byTenantId.get(tenantId) ?? null;
  }

  async upsert(tenantId: string, email: string, passwordHash: string): Promise<AdminCredentialRecord> {
    const existingWithEmail = await this.findByEmail(email);
    if (existingWithEmail && existingWithEmail.tenantId !== tenantId) {
      throw new AdminCredentialEmailInUseError(email);
    }
    const now = new Date();
    const existing = this.byTenantId.get(tenantId);
    const record: AdminCredentialRecord = {
      tenantId,
      email,
      passwordHash,
      failedAttempts: 0,
      lockedUntil: null,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    this.byTenantId.set(tenantId, record);
    return record;
  }

  async incrementFailedAttempts(tenantId: string, lockedUntil: Date | null): Promise<AdminCredentialRecord | null> {
    const record = this.byTenantId.get(tenantId);
    if (!record) {
      return null;
    }
    record.failedAttempts += 1;
    record.lockedUntil = lockedUntil;
    return record;
  }

  async resetFailedAttempts(tenantId: string): Promise<void> {
    const record = this.byTenantId.get(tenantId);
    if (record) {
      record.failedAttempts = 0;
      record.lockedUntil = null;
    }
  }

  async deleteForTenant(tenantId: string): Promise<void> {
    this.byTenantId.delete(tenantId);
  }
}
