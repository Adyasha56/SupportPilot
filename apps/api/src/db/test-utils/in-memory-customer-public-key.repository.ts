import { randomUUID } from 'node:crypto';
import {
  ActiveKeyLimitExceededError,
  CustomerPublicKeyRecord,
  CustomerPublicKeyRepository,
  DuplicateKidError,
} from '../customer-public-key.repository';

export class InMemoryCustomerPublicKeyRepository implements CustomerPublicKeyRepository {
  private readonly keys: CustomerPublicKeyRecord[] = [];

  async register(tenantId: string, kid: number, publicKeyX: string, maxActiveKeys: number): Promise<CustomerPublicKeyRecord> {
    if (this.keys.some((k) => k.tenantId === tenantId && k.kid === kid)) {
      throw new DuplicateKidError(`A key with kid ${kid} already exists for tenant "${tenantId}".`);
    }
    const activeCount = await this.countActiveForTenant(tenantId);
    if (activeCount >= maxActiveKeys) {
      throw new ActiveKeyLimitExceededError(`Tenant "${tenantId}" already has ${activeCount} active keys (max ${maxActiveKeys}).`);
    }
    const record: CustomerPublicKeyRecord = { id: randomUUID(), tenantId, kid, publicKeyX, status: 'active', createdAt: new Date() };
    this.keys.push(record);
    return record;
  }

  async retire(tenantId: string, kid: number): Promise<boolean> {
    const record = this.keys.find((k) => k.tenantId === tenantId && k.kid === kid && k.status === 'active');
    if (!record) {
      return false;
    }
    record.status = 'retired';
    return true;
  }

  async findActive(tenantId: string, kid: number): Promise<string | undefined> {
    return this.keys.find((k) => k.tenantId === tenantId && k.kid === kid && k.status === 'active')?.publicKeyX;
  }

  async countActiveForTenant(tenantId: string): Promise<number> {
    return this.keys.filter((k) => k.tenantId === tenantId && k.status === 'active').length;
  }

  async deleteForTenant(tenantId: string): Promise<void> {
    for (let i = this.keys.length - 1; i >= 0; i--) {
      if (this.keys[i].tenantId === tenantId) {
        this.keys.splice(i, 1);
      }
    }
  }
}
