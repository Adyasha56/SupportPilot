import { randomUUID } from 'node:crypto';
import { ApiKeyScope } from '../schemas/api-key.schema';
import { ApiKeyLookup, ApiKeyRepository } from '../api-key.repository';

export class InMemoryApiKeyRepository implements ApiKeyRepository {
  private readonly byId = new Map<string, ApiKeyLookup>();

  async create(tenantId: string, hash: string, _keyPrefix: string, scopes: ApiKeyScope[]): Promise<string> {
    const id = randomUUID();
    this.byId.set(id, { id, tenantId, scopes, revokedAt: null, hash });
    return id;
  }

  async findByHash(hash: string): Promise<ApiKeyLookup | null> {
    for (const record of this.byId.values()) {
      if (record.hash === hash) {
        return record;
      }
    }
    return null;
  }

  async revoke(id: string): Promise<boolean> {
    const record = this.byId.get(id);
    if (!record || record.revokedAt) {
      return false;
    }
    record.revokedAt = new Date();
    return true;
  }
}
