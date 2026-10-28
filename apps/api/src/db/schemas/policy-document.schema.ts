import { Schema, Types } from 'mongoose';
import { POLICY_FAILURE_CODES, PolicyFailureCode } from '@supportpilot/shared';

export type PolicyDocumentStatus = 'pending' | 'ready' | 'failed';

export interface PolicyDocumentDocument {
  _id: Types.ObjectId;
  tenantId: string;
  title: string;
  status: PolicyDocumentStatus;
  /** SHA-256 of the normalized (CRLF->LF, front-matter-stripped) upload text - used to detect a tenant re-uploading the same content. */
  contentHash: string;
  chunkCount: number;
  failureCode: PolicyFailureCode | null;
  uploadedAt: Date;
}

export const PolicyDocumentSchema = new Schema<PolicyDocumentDocument>(
  {
    tenantId: { type: String, required: true, index: true },
    title: { type: String, required: true },
    status: {
      type: String,
      required: true,
      enum: ['pending', 'ready', 'failed'],
      default: 'pending',
    },
    contentHash: { type: String, required: true },
    chunkCount: { type: Number, required: true, default: 0 },
    failureCode: { type: String, enum: POLICY_FAILURE_CODES, default: null },
  },
  { collection: 'policyDocuments', timestamps: { createdAt: 'uploadedAt', updatedAt: false } },
);

// Duplicate-content detection is scoped per tenant - the same contentHash
// is expected to recur across different tenants (two companies uploading
// the same boilerplate refund policy is normal), so this is NOT a unique
// index, just a lookup index.
PolicyDocumentSchema.index({ tenantId: 1, contentHash: 1 });

// Plain (non-Search) index for GET /v1/policies listing - doesn't count
// toward the M0 Search/Vector index cap, which only applies to Search-type
// indexes.
PolicyDocumentSchema.index({ tenantId: 1, uploadedAt: -1 });
