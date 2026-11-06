import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { CustomerPublicKeyDocument, CustomerPublicKeyStatus } from './schemas/customer-public-key.schema';

export interface CustomerPublicKeyRecord {
  id: string;
  tenantId: string;
  kid: number;
  publicKeyX: string;
  status: CustomerPublicKeyStatus;
  createdAt: Date;
}

export class DuplicateKidError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DuplicateKidError';
  }
}

export class ActiveKeyLimitExceededError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ActiveKeyLimitExceededError';
  }
}

export interface CustomerPublicKeyRepository {
  /** Throws DuplicateKidError if (tenantId, kid) already exists, ActiveKeyLimitExceededError if the tenant is already at maxActiveKeys active keys. */
  register(tenantId: string, kid: number, publicKeyX: string, maxActiveKeys: number): Promise<CustomerPublicKeyRecord>;
  retire(tenantId: string, kid: number): Promise<boolean>;
  /**
   * The exact `lookupPublicKey` function verifyCustomerToken() expects -
   * returns undefined for an unknown OR retired kid, so a retired key
   * behaves identically to one that never existed (UNKNOWN_KID), never a
   * distinguishable "this key used to work" signal.
   */
  findActive(tenantId: string, kid: number): Promise<string | undefined>;
  countActiveForTenant(tenantId: string): Promise<number>;
  /** Test/ops cleanup only. */
  deleteForTenant(tenantId: string): Promise<void>;
}

export const CUSTOMER_PUBLIC_KEY_REPOSITORY = Symbol('CUSTOMER_PUBLIC_KEY_REPOSITORY');

function toRecord(doc: CustomerPublicKeyDocument): CustomerPublicKeyRecord {
  return {
    id: doc._id.toString(),
    tenantId: doc.tenantId,
    kid: doc.kid,
    publicKeyX: doc.publicKeyX,
    status: doc.status,
    createdAt: doc.createdAt,
  };
}

@Injectable()
export class MongooseCustomerPublicKeyRepository implements CustomerPublicKeyRepository {
  constructor(@InjectModel('CustomerPublicKey') private readonly model: Model<CustomerPublicKeyDocument>) {}

  async register(tenantId: string, kid: number, publicKeyX: string, maxActiveKeys: number): Promise<CustomerPublicKeyRecord> {
    const existing = await this.model.findOne({ tenantId, kid }).lean();
    if (existing) {
      throw new DuplicateKidError(`A key with kid ${kid} already exists for tenant "${tenantId}".`);
    }
    const activeCount = await this.countActiveForTenant(tenantId);
    if (activeCount >= maxActiveKeys) {
      throw new ActiveKeyLimitExceededError(`Tenant "${tenantId}" already has ${activeCount} active keys (max ${maxActiveKeys}).`);
    }
    const doc = await this.model.create({ tenantId, kid, publicKeyX, status: 'active' });
    return toRecord(doc);
  }

  async retire(tenantId: string, kid: number): Promise<boolean> {
    const result = await this.model.updateOne({ tenantId, kid, status: 'active' }, { $set: { status: 'retired' } });
    return result.modifiedCount > 0;
  }

  async findActive(tenantId: string, kid: number): Promise<string | undefined> {
    const doc = await this.model.findOne({ tenantId, kid, status: 'active' }).lean();
    return doc?.publicKeyX;
  }

  async countActiveForTenant(tenantId: string): Promise<number> {
    return this.model.countDocuments({ tenantId, status: 'active' });
  }

  async deleteForTenant(tenantId: string): Promise<void> {
    await this.model.deleteMany({ tenantId });
  }
}
