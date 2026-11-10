import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { TenantDocument } from './schemas/tenant.schema';
import { validateEffectiveTenantSettings } from './tenant-settings-validation';

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

/**
 * Milestone 4 amendment N-e: a tenant document created before a given
 * settings field existed (or before Milestone 4 at all) must read back
 * the SAME demo default a freshly-created tenant gets, never `undefined`
 * - a legacy tenant silently behaving as "no refund window at all" (an
 * undefined refundWindowDays would make the verifier's rule 6 always
 * fail) would be a much worse failure mode than just applying the
 * documented default. dailyRefundCountLimit is deliberately excluded -
 * "no limit configured" is its own real, intentional meaning, not a gap
 * to fill with a default.
 */
export function toTenant(doc: Pick<TenantDocument, '_id' | 'name' | 'settings'>): Tenant {
  const settings = doc.settings ?? {};
  return {
    id: doc._id,
    name: doc.name,
    ...(settings.allowedOrigins ? { allowedOrigins: settings.allowedOrigins } : {}),
    refundCap: settings.refundCap ?? DEMO_TENANT_SETTINGS.refundCap,
    approvalThreshold: settings.approvalThreshold ?? DEMO_TENANT_SETTINGS.approvalThreshold,
    refundWindowDays: settings.refundWindowDays ?? DEMO_TENANT_SETTINGS.refundWindowDays,
    autoExecuteRefunds: settings.autoExecuteRefunds ?? DEMO_TENANT_SETTINGS.autoExecuteRefunds,
    approvalExpiryDays: settings.approvalExpiryDays ?? DEMO_TENANT_SETTINGS.approvalExpiryDays,
    ...(settings.dailyRefundCountLimit !== undefined ? { dailyRefundCountLimit: settings.dailyRefundCountLimit } : {}),
  };
}

const SETTINGS_PATCH_KEYS = ['refundCap', 'approvalThreshold', 'refundWindowDays', 'autoExecuteRefunds', 'approvalExpiryDays', 'dailyRefundCountLimit'] as const;

@Injectable()
export class MongooseTenantRepository implements TenantRepository {
  private readonly logger = new Logger(MongooseTenantRepository.name);

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
    return toTenant(doc!);
  }

  /**
   * Milestone 4 amendments N-b/N-d: validates the EFFECTIVE merged settings
   * (current, defaults-applied values with patch's defined keys overlaid) -
   * not patch in isolation - so a call that only passes --approvalThreshold
   * still gets rejected if the result would exceed an already-stored
   * refundCap, and logs a structured audit line naming only the keys that
   * actually changed (settings values are not secrets, unlike customer
   * PII, so logging their actual before/after values is fine and useful).
   * Not atomic against a concurrent second admin call - acceptable for a
   * single-operator CLI tool with no admin console yet (Milestone 5).
   */
  async updateSettings(tenantId: string, patch: TenantSettingsPatch): Promise<Tenant> {
    const existingDoc = await this.model.findById(tenantId).lean();
    if (!existingDoc) {
      throw new TenantNotFoundError(tenantId);
    }
    const before = toTenant(existingDoc);
    const effective = { ...before, ...removeUndefinedPatchEntries(patch) };
    validateEffectiveTenantSettings(effective);

    const $set: Record<string, unknown> = {};
    const changedKeys: (typeof SETTINGS_PATCH_KEYS)[number][] = [];
    for (const key of SETTINGS_PATCH_KEYS) {
      const value = patch[key];
      if (value !== undefined && value !== before[key]) {
        $set[`settings.${key}`] = value;
        changedKeys.push(key);
      }
    }

    // Every passed value already equals what's stored (e.g. a no-op re-run) - an empty $set
    // is itself a MongoDB error, and there is nothing to change or audit-log anyway.
    if (changedKeys.length === 0) {
      return before;
    }

    const doc = await this.model.findByIdAndUpdate(tenantId, { $set }, { new: true }).lean();
    if (!doc) {
      throw new TenantNotFoundError(tenantId);
    }
    const after = toTenant(doc);

    this.logger.log(
      JSON.stringify({
        event: 'tenant_settings_changed',
        tenantId,
        changedKeys,
        before: Object.fromEntries(changedKeys.map((key) => [key, before[key]])),
        after: Object.fromEntries(changedKeys.map((key) => [key, after[key]])),
      }),
    );

    return after;
  }
}

/** A patch may structurally carry `undefined` for every key (TenantSettingsPatch is a Partial) - this is the one place that's filtered out before a merge, so an omitted flag never overwrites a stored value with undefined. */
function removeUndefinedPatchEntries(patch: TenantSettingsPatch): Partial<TenantSettingsPatch> {
  const result: Partial<TenantSettingsPatch> = {};
  for (const key of SETTINGS_PATCH_KEYS) {
    const value = patch[key];
    if (value !== undefined) {
      (result as Record<string, unknown>)[key] = value;
    }
  }
  return result;
}
