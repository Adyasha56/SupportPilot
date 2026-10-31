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
 *
 * approvalThreshold (250) matches sample-policy.md's own stated $250
 * manager-approval trigger ("Refunds Above $250") - kept in agreement on
 * purpose, see docs/learning-notes.md's Stage 9 consistency table.
 *
 * refundCap (2000) is a DEMO operational ceiling, not a number stated
 * anywhere in the policy text - the policy itself states no maximum refund
 * amount at all, only the $250 approval trigger. This is deliberately an
 * operational safety limit (every real system needs SOME hard ceiling on
 * an automated money-moving action), not a fact the agent could ever cite
 * from the policy, and the Milestone 3 agent must never present it as one.
 * $2000 is chosen high enough that no seeded mock-store order (the
 * highest, ORD-1006, is $1249.00) is ever blocked by it in an eval case -
 * a cap that silently blocked a seeded scenario would be a harder-to-spot
 * bug than one that's simply never exercised by this project's own fixtures.
 */
export const DEMO_TENANT_SETTINGS = {
  refundCap: 2000,
  approvalThreshold: 250,
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
