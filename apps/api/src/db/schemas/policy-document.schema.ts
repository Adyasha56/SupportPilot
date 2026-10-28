import { Schema, Types } from 'mongoose';

export type PolicyDocumentStatus = 'pending' | 'ready' | 'failed';

export interface PolicyDocumentDocument {
  _id: Types.ObjectId;
  tenantId: string;
  title: string;
  status: PolicyDocumentStatus;
  chunkCount: number;
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
    chunkCount: { type: Number, required: true, default: 0 },
  },
  { collection: 'policyDocuments', timestamps: { createdAt: 'uploadedAt', updatedAt: false } },
);

// Plain (non-Search) index for GET /v1/policies listing - doesn't count
// toward the M0 Search/Vector index cap, which only applies to Search-type
// indexes.
PolicyDocumentSchema.index({ tenantId: 1, uploadedAt: -1 });
