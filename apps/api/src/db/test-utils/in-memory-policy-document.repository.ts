import { randomUUID } from 'node:crypto';
import { PolicyFailureCode } from '@supportpilot/shared';
import { PolicyDocumentRecord, PolicyDocumentRepository } from '../policy-document.repository';

export class InMemoryPolicyDocumentRepository implements PolicyDocumentRepository {
  private readonly documents = new Map<string, PolicyDocumentRecord>();

  async create(tenantId: string, title: string, contentHash: string): Promise<PolicyDocumentRecord> {
    const record: PolicyDocumentRecord = {
      id: randomUUID(),
      tenantId,
      title,
      status: 'pending',
      contentHash,
      chunkCount: 0,
      failureCode: null,
      uploadedAt: new Date(),
    };
    this.documents.set(record.id, record);
    return record;
  }

  async markReady(tenantId: string, id: string, chunkCount: number): Promise<void> {
    const record = this.documents.get(id);
    if (record && record.tenantId === tenantId) {
      record.status = 'ready';
      record.chunkCount = chunkCount;
      record.failureCode = null;
    }
  }

  async markFailed(tenantId: string, id: string, failureCode: PolicyFailureCode): Promise<void> {
    const record = this.documents.get(id);
    if (record && record.tenantId === tenantId) {
      record.status = 'failed';
      record.failureCode = failureCode;
    }
  }

  async findAllForTenant(tenantId: string): Promise<PolicyDocumentRecord[]> {
    return [...this.documents.values()]
      .filter((doc) => doc.tenantId === tenantId)
      .sort((a, b) => b.uploadedAt.getTime() - a.uploadedAt.getTime());
  }

  async findById(tenantId: string, id: string): Promise<PolicyDocumentRecord | null> {
    const record = this.documents.get(id);
    return record && record.tenantId === tenantId ? record : null;
  }

  async findByContentHash(tenantId: string, contentHash: string): Promise<PolicyDocumentRecord | null> {
    const record = [...this.documents.values()].find(
      (doc) => doc.tenantId === tenantId && doc.contentHash === contentHash && (doc.status === 'pending' || doc.status === 'ready'),
    );
    return record ?? null;
  }

  async countActiveForTenant(tenantId: string): Promise<number> {
    return [...this.documents.values()].filter(
      (doc) => doc.tenantId === tenantId && (doc.status === 'pending' || doc.status === 'ready'),
    ).length;
  }

  async delete(tenantId: string, id: string): Promise<boolean> {
    const record = this.documents.get(id);
    if (!record || record.tenantId !== tenantId) {
      return false;
    }
    return this.documents.delete(id);
  }

  async findStalePending(olderThan: Date): Promise<PolicyDocumentRecord[]> {
    return [...this.documents.values()].filter(
      (doc) => doc.status === 'pending' && doc.uploadedAt < olderThan,
    );
  }
}
