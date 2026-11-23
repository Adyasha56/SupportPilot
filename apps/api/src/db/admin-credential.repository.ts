import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { AdminCredentialDocument } from './schemas/admin-credential.schema';

export interface AdminCredentialRecord {
  tenantId: string;
  email: string;
  passwordHash: string;
  failedAttempts: number;
  lockedUntil: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

/** Milestone 5, Stage 1b, item 1 - thrown instead of a raw Mongo E11000 when `upsert`'s email collides with a DIFFERENT tenant's credential (email is globally unique, never per-tenant). */
export class AdminCredentialEmailInUseError extends Error {
  constructor(email: string) {
    super(`Email "${email}" is already in use by a different tenant's admin credential.`);
  }
}

export interface AdminCredentialRepository {
  findByEmail(email: string): Promise<AdminCredentialRecord | null>;
  findByTenantId(tenantId: string): Promise<AdminCredentialRecord | null>;
  /** Create-or-replace, keyed by tenantId (_id) - set-admin-credential.ts's own "on an existing email it replaces the hash" behavior. Resets failedAttempts/lockedUntil, since this is always an administrative reset, never a login. Throws AdminCredentialEmailInUseError if `email` already belongs to a different tenant. */
  upsert(tenantId: string, email: string, passwordHash: string): Promise<AdminCredentialRecord>;
  /** Atomically increments failedAttempts and sets lockedUntil (or null to clear it) in one write - never a separate read-then-write. */
  incrementFailedAttempts(tenantId: string, lockedUntil: Date | null): Promise<AdminCredentialRecord | null>;
  /** On a successful login - failedAttempts back to 0, lockedUntil cleared. */
  resetFailedAttempts(tenantId: string): Promise<void>;
  /** Part 0, item Q1 - rehash-on-successful-login. A NARROW, single-field update - deliberately never touches failedAttempts/lockedUntil/email, unlike `upsert` (which is an administrative reset, not a transparent background rehash). */
  updatePasswordHash(tenantId: string, passwordHash: string): Promise<void>;
  /** Test/ops cleanup only. */
  deleteForTenant(tenantId: string): Promise<void>;
}

export const ADMIN_CREDENTIAL_REPOSITORY = Symbol('ADMIN_CREDENTIAL_REPOSITORY');

const DUPLICATE_KEY_ERROR_CODE = 11000;

function toRecord(doc: AdminCredentialDocument): AdminCredentialRecord {
  return {
    tenantId: doc._id,
    email: doc.email,
    passwordHash: doc.passwordHash,
    failedAttempts: doc.failedAttempts,
    lockedUntil: doc.lockedUntil,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
}

@Injectable()
export class MongooseAdminCredentialRepository implements AdminCredentialRepository {
  constructor(@InjectModel('AdminCredential') private readonly model: Model<AdminCredentialDocument>) {}

  async findByEmail(email: string): Promise<AdminCredentialRecord | null> {
    const doc = await this.model.findOne({ email }).lean();
    return doc ? toRecord(doc as unknown as AdminCredentialDocument) : null;
  }

  async findByTenantId(tenantId: string): Promise<AdminCredentialRecord | null> {
    const doc = await this.model.findById(tenantId).lean();
    return doc ? toRecord(doc as unknown as AdminCredentialDocument) : null;
  }

  async upsert(tenantId: string, email: string, passwordHash: string): Promise<AdminCredentialRecord> {
    try {
      const doc = await this.model.findOneAndUpdate(
        { _id: tenantId },
        { $set: { email, passwordHash, failedAttempts: 0, lockedUntil: null } },
        { upsert: true, new: true, setDefaultsOnInsert: true },
      );
      return toRecord(doc!);
    } catch (err) {
      if (typeof err === 'object' && err !== null && 'code' in err && (err as { code: unknown }).code === DUPLICATE_KEY_ERROR_CODE) {
        throw new AdminCredentialEmailInUseError(email);
      }
      throw err;
    }
  }

  async incrementFailedAttempts(tenantId: string, lockedUntil: Date | null): Promise<AdminCredentialRecord | null> {
    const doc = await this.model.findOneAndUpdate({ _id: tenantId }, { $inc: { failedAttempts: 1 }, $set: { lockedUntil } }, { new: true });
    return doc ? toRecord(doc) : null;
  }

  async resetFailedAttempts(tenantId: string): Promise<void> {
    await this.model.updateOne({ _id: tenantId }, { $set: { failedAttempts: 0, lockedUntil: null } });
  }

  async updatePasswordHash(tenantId: string, passwordHash: string): Promise<void> {
    await this.model.updateOne({ _id: tenantId }, { $set: { passwordHash } });
  }

  async deleteForTenant(tenantId: string): Promise<void> {
    await this.model.deleteOne({ _id: tenantId });
  }
}
