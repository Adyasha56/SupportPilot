import { Schema } from 'mongoose';
import { TENANT_ID_PATTERN } from '@supportpilot/shared';

/**
 * _id is the tenant slug itself (e.g. "acme"), not an ObjectId - matching
 * the connector config folder names exactly, so there's one tenant
 * identifier used everywhere, never a separate internal id to keep in sync.
 */
export interface TenantDocument {
  _id: string;
  name: string;
  settings: {
    refundCap?: number;
    approvalThreshold?: number;
    tone?: string;
    /** Stage 3 - see Tenant.allowedOrigins's own doc comment (db/tenant.repository.ts) for what this is and isn't used for. */
    allowedOrigins?: string[];
    /**
     * Milestone 4 - the refund-verifier's rule 6 (apps/api/src/approvals/refund-verifier.ts).
     * Deliberately duplicates the policy document's own stated refund window
     * in prose (see PROJECT.md's Milestone 4 plan, "window-vs-policy-text
     * duplication") - the same pre-existing drift risk approvalThreshold/
     * refundCap already carry, tracked in the same consistency table rather
     * than solved by a new mechanism.
     */
    refundWindowDays?: number;
    /**
     * Milestone 4 (D1) - off by default. When true, a proposal at or below
     * approvalThreshold that passes every verifier rule executes without a
     * human; above approvalThreshold it still requires approval regardless
     * of this flag.
     */
    autoExecuteRefunds?: boolean;
    /** Milestone 4 - how many days a pending Approval stays decidable before a decision attempt finds it expired. */
    approvalExpiryDays?: number;
    /** Milestone 4, optional (verifier rule 9) - omitted/undefined means "no limit", never "zero". */
    dailyRefundCountLimit?: number;
  };
  createdAt: Date;
}

export const TenantSchema = new Schema<TenantDocument>(
  {
    _id: { type: String, required: true, match: TENANT_ID_PATTERN },
    name: { type: String, required: true },
    settings: {
      refundCap: { type: Number },
      approvalThreshold: { type: Number },
      tone: { type: String },
      allowedOrigins: { type: [String] },
      refundWindowDays: { type: Number },
      autoExecuteRefunds: { type: Boolean },
      approvalExpiryDays: { type: Number },
      dailyRefundCountLimit: { type: Number },
    },
  },
  { collection: 'tenants', timestamps: { createdAt: true, updatedAt: false } },
);
