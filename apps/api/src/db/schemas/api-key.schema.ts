import { Schema, Types } from 'mongoose';

export type ApiKeyScope = 'public' | 'secret';

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
    scopes: { type: [String], required: true, enum: ['public', 'secret'] },
    revokedAt: { type: Date, default: null },
  },
  { collection: 'apiKeys', timestamps: { createdAt: true, updatedAt: false } },
);
