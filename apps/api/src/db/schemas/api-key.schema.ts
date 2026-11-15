import { Schema, Types } from 'mongoose';

/**
 * Milestone 4 Stage 6, amendment E - `admin` is strictly ABOVE `secret`, which is strictly
 * above `public` (a rank, not a set of independent flags - see api-key.guard.ts's own
 * scopeSatisfies). A `secret`-scope key, which already works on every other `/v1/*` endpoint,
 * gets the exact same generic rejection a `public` key does on `/v1/approvals*` - this is the
 * interim admin-auth story; Milestone 5's admin console login eventually replaces standing
 * admin API keys, the same way secret keys are an interim mechanism for policies/connectors
 * today.
 */
export type ApiKeyScope = 'public' | 'secret' | 'admin';

export interface ApiKeyDocument {
  _id: Types.ObjectId;
  tenantId: string;
  /** SHA-256 hex digest of the raw key, never the raw value itself. select:false. */
  hash: string;
  /** First 8 characters of the raw key, for display only (e.g. an admin console key list) - never used for lookup. */
  keyPrefix: string;
  scopes: ApiKeyScope[];
  createdAt: Date;
  revokedAt: Date | null;
}

export const ApiKeySchema = new Schema<ApiKeyDocument>(
  {
    tenantId: { type: String, required: true, index: true },
    hash: { type: String, required: true, unique: true, select: false },
    keyPrefix: { type: String, required: true },
    scopes: { type: [String], required: true, enum: ['public', 'secret', 'admin'] },
    revokedAt: { type: Date, default: null },
  },
  { collection: 'apiKeys', timestamps: { createdAt: true, updatedAt: false } },
);
