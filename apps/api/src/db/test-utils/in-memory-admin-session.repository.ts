import { randomUUID } from 'node:crypto';
import { AdminSessionRecord, AdminSessionRepository, NewAdminSession } from '../admin-session.repository';

export class InMemoryAdminSessionRepository implements AdminSessionRepository {
  private readonly sessions = new Map<string, AdminSessionRecord>();

  async create(session: NewAdminSession): Promise<AdminSessionRecord> {
    const record: AdminSessionRecord = { id: randomUUID(), createdAt: new Date(), ...session };
    this.sessions.set(record.id, record);
    return record;
  }

  async findByTokenHash(tokenHash: string): Promise<AdminSessionRecord | null> {
    for (const record of this.sessions.values()) {
      if (record.tokenHash === tokenHash) {
        return record;
      }
    }
    return null;
  }

  async findById(id: string): Promise<AdminSessionRecord | null> {
    return this.sessions.get(id) ?? null;
  }

  async updateLastSeenAt(id: string, now: Date): Promise<void> {
    const record = this.sessions.get(id);
    if (record) {
      record.lastSeenAt = now;
    }
  }

  async deleteById(id: string): Promise<void> {
    this.sessions.delete(id);
  }

  async deleteAllForPrincipal(tenantId: string, principalId: string): Promise<void> {
    for (const [id, record] of this.sessions) {
      if (record.tenantId === tenantId && record.principalId === principalId) {
        this.sessions.delete(id);
      }
    }
  }

  async deleteForTenant(tenantId: string): Promise<void> {
    for (const [id, record] of this.sessions) {
      if (record.tenantId === tenantId) {
        this.sessions.delete(id);
      }
    }
  }
}
