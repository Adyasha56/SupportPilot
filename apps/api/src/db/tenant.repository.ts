import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { TenantDocument } from './schemas/tenant.schema';

export interface Tenant {
  id: string;
  name: string;
  /**
   * Stage 3 - the Origin "speed bump" allowlist for this tenant's PUBLIC
   * (widget) key only (ApiKeyGuard.checkOriginSpeedBump). Undefined or
   * empty means "not configured" - the check is skipped entirely, never
   * treated as "nothing is allowed." Never a security boundary (see that
   * method's own doc comment) - a real admin console (Milestone 5) lets a
   * tenant admin set this.
   */
  allowedOrigins?: string[];
  /** Milestone 4 - the refund-verifier's hard ceiling (rule 7), always enforced, never bypassed by autoExecuteRefunds. */
  refundCap?: number;
  /** Milestone 4 - the auto/human split: at or below this, autoExecuteRefunds (if on) skips the human; above it, a human is always required regardless of the flag. */
  approvalThreshold?: number;
  /** Milestone 4 - the refund-verifier's rule 6; see TenantDocument.settings.refundWindowDays's own doc comment. */
  refundWindowDays?: number;
  /** Milestone 4 (D1) - off (undefined/false) by default. */
  autoExecuteRefunds?: boolean;
  /** Milestone 4 - how many days a pending Approval stays decidable. */
  approvalExpiryDays?: number;
  /** Milestone 4, optional verifier rule 9 - undefined means "no limit". */
  dailyRefundCountLimit?: number;
}

/** The subset of Tenant.settings that updateSettings can change - everything except the identity fields (id/name) and allowedOrigins, which has its own update path (not built yet - Milestone 5). */
export type TenantSettingsPatch = Partial<
  Pick<Tenant, 'refundCap' | 'approvalThreshold' | 'refundWindowDays' | 'autoExecuteRefunds' | 'approvalExpiryDays' | 'dailyRefundCountLimit'>
>;

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
 *
 * refundWindowDays (30) matches sample-policy.md's own stated "30 days of
 * the delivery date" standard refund window - same on-purpose agreement as
 * approvalThreshold above, now a third row in the Stage 9 consistency
 * table. autoExecuteRefunds defaults to false (Milestone 4 decision D1 -
 * every refund requires human approval unless a tenant opts in).
 * approvalExpiryDays (7) is a demo operational default, not stated in the
 * policy text.
 */
export const DEMO_TENANT_SETTINGS = {
  refundCap: 2000,
  approvalThreshold: 250,
  tone: 'friendly and professional',
  refundWindowDays: 30,
  autoExecuteRefunds: false,
  approvalExpiryDays: 7,
} as const;

export interface TenantRepository {
  findById(tenantId: string): Promise<Tenant | null>;
  /** Used by create-api-key: creates the tenant with demo settings if it doesn't exist yet. */
  upsert(tenantId: string, name: string): Promise<Tenant>;
  /** Milestone 4 - set-tenant-settings.ts's only write path. Only the keys present in patch are changed; throws if the tenant doesn't exist (never silently upserts a partial tenant). */
  updateSettings(tenantId: string, patch: TenantSettingsPatch): Promise<Tenant>;
}

export const TENANT_REPOSITORY = Symbol('TENANT_REPOSITORY');

export class TenantNotFoundError extends Error {
  constructor(tenantId: string) {
    super(`No tenant found with id "${tenantId}".`);
  }
}

function toTenant(doc: Pick<TenantDocument, '_id' | 'name' | 'settings'>): Tenant {
  const settings = doc.settings ?? {};
  return {
    id: doc._id,
    name: doc.name,
    ...(settings.allowedOrigins ? { allowedOrigins: settings.allowedOrigins } : {}),
    ...(settings.refundCap !== undefined ? { refundCap: settings.refundCap } : {}),
    ...(settings.approvalThreshold !== undefined ? { approvalThreshold: settings.approvalThreshold } : {}),
    ...(settings.refundWindowDays !== undefined ? { refundWindowDays: settings.refundWindowDays } : {}),
    ...(settings.autoExecuteRefunds !== undefined ? { autoExecuteRefunds: settings.autoExecuteRefunds } : {}),
    ...(settings.approvalExpiryDays !== undefined ? { approvalExpiryDays: settings.approvalExpiryDays } : {}),
    ...(settings.dailyRefundCountLimit !== undefined ? { dailyRefundCountLimit: settings.dailyRefundCountLimit } : {}),
  };
}

@Injectable()
export class MongooseTenantRepository implements TenantRepository {
  constructor(@InjectModel('Tenant') private readonly model: Model<TenantDocument>) {}

  async findById(tenantId: string): Promise<Tenant | null> {
    const doc = await this.model.findById(tenantId).lean();
    if (!doc) {
      return null;
    }
    return toTenant(doc);
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

  async updateSettings(tenantId: string, patch: TenantSettingsPatch): Promise<Tenant> {
    const $set: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(patch)) {
      if (value !== undefined) {
        $set[`settings.${key}`] = value;
      }
    }
    const doc = await this.model.findByIdAndUpdate(tenantId, { $set }, { new: true }).lean();
    if (!doc) {
      throw new TenantNotFoundError(tenantId);
    }
    return toTenant(doc);
  }
}
