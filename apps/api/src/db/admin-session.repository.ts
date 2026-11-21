import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { AdminSessionDocument } from './schemas/admin-session.schema';

export interface AdminSessionRecord {
  id: string;
  tenantId: string;
  principalId: string;
  tokenHash: string;
  csrfToken: string;
  createdAt: Date;
  lastSeenAt: Date;
  absoluteExpiresAt: Date;
  idleTimeoutMs: number;
}

export interface NewAdminSession {
  tenantId: string;
  principalId: string;
  tokenHash: string;
  csrfToken: string;
  lastSeenAt: Date;
  absoluteExpiresAt: Date;
  idleTimeoutMs: number;
}

export interface AdminSessionRepository {
  create(session: NewAdminSession): Promise<AdminSessionRecord>;
  findByTokenHash(tokenHash: string): Promise<AdminSessionRecord | null>;
  /** Only ever called with an id the CALLER already authenticated ownership of (AdminAuthGuard's own cookie/tokenHash check ran first) - never reachable from an unauthenticated id guess. */
  findById(id: string): Promise<AdminSessionRecord | null>;
  /** item 5 - "at most once per minute" is enforced by the CALLER (admin-auth.guard.ts), by only invoking this when lastSeenAt is already stale enough; this method itself always writes when called. */
  updateLastSeenAt(id: string, now: Date): Promise<void>;
  deleteById(id: string): Promise<void>;
  /** Revokes every OTHER session of this principal - set-admin-credential.ts (item 1, a password change) and login's own anti-fixation step (item 3: a session cookie presented at login is invalidated). */
  deleteAllForPrincipal(tenantId: string, principalId: string): Promise<void>;
  /** Test/ops cleanup only. */
  deleteForTenant(tenantId: string): Promise<void>;
}

export const ADMIN_SESSION_REPOSITORY = Symbol('ADMIN_SESSION_REPOSITORY');

function toRecord(doc: AdminSessionDocument): AdminSessionRecord {
  return {
    id: String(doc._id),
    tenantId: doc.tenantId,
    principalId: doc.principalId,
    tokenHash: doc.tokenHash,
    csrfToken: doc.csrfToken,
    createdAt: doc.createdAt,
    lastSeenAt: doc.lastSeenAt,
    absoluteExpiresAt: doc.absoluteExpiresAt,
    idleTimeoutMs: doc.idleTimeoutMs,
  };
}

@Injectable()
export class MongooseAdminSessionRepository implements AdminSessionRepository {
  constructor(@InjectModel('AdminSession') private readonly model: Model<AdminSessionDocument>) {}

  async create(session: NewAdminSession): Promise<AdminSessionRecord> {
    const doc = await this.model.create(session);
    return toRecord(doc);
  }

  async findByTokenHash(tokenHash: string): Promise<AdminSessionRecord | null> {
    const doc = await this.model.findOne({ tokenHash }).lean();
    return doc ? toRecord(doc as unknown as AdminSessionDocument) : null;
  }

  async findById(id: string): Promise<AdminSessionRecord | null> {
    const doc = await this.model.findById(id).lean();
    return doc ? toRecord(doc as unknown as AdminSessionDocument) : null;
  }

  async updateLastSeenAt(id: string, now: Date): Promise<void> {
    await this.model.updateOne({ _id: id }, { $set: { lastSeenAt: now } });
  }

  async deleteById(id: string): Promise<void> {
    await this.model.deleteOne({ _id: id });
  }

  async deleteAllForPrincipal(tenantId: string, principalId: string): Promise<void> {
    await this.model.deleteMany({ tenantId, principalId });
  }

  async deleteForTenant(tenantId: string): Promise<void> {
    await this.model.deleteMany({ tenantId });
  }
}
