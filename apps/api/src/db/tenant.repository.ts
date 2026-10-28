import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { TenantDocument } from './schemas/tenant.schema';

export interface Tenant {
  id: string;
  name: string;
}

/**
 * DEMO VALUES - a real admin console (Milestone 5) must let each tenant set
 * their own. These exist only so a freshly-created tenant has something
 * usable rather than undefined settings breaking downstream logic (e.g. the
 * Milestone 4 verifier reading refundCap).
 */
export const DEMO_TENANT_SETTINGS = {
  refundCap: 500,
  approvalThreshold: 100,
  tone: 'friendly and professional',
} as const;

export interface TenantRepository {
  findById(tenantId: string): Promise<Tenant | null>;
  /** Used by create-api-key: creates the tenant with demo settings if it doesn't exist yet. */
  upsert(tenantId: string, name: string): Promise<Tenant>;
}

export const TENANT_REPOSITORY = Symbol('TENANT_REPOSITORY');

@Injectable()
export class MongooseTenantRepository implements TenantRepository {
  constructor(@InjectModel('Tenant') private readonly model: Model<TenantDocument>) {}

  async findById(tenantId: string): Promise<Tenant | null> {
    const doc = await this.model.findById(tenantId).lean();
    return doc ? { id: doc._id, name: doc.name } : null;
  }

  async upsert(tenantId: string, name: string): Promise<Tenant> {
    const doc = await this.model
      .findByIdAndUpdate(
        tenantId,
        { $setOnInsert: { _id: tenantId, name, settings: DEMO_TENANT_SETTINGS } },
        { upsert: true, new: true },
      )
      .lean();
    return { id: doc!._id, name: doc!.name };
  }
}
