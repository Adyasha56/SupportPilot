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
    },
  },
  { collection: 'tenants', timestamps: { createdAt: true, updatedAt: false } },
);
