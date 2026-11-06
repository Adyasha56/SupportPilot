import { Schema } from 'mongoose';
import { GENERIC_ID_PATTERN } from '@supportpilot/shared';

export type ConversationStatus = 'open' | 'closed';

/**
 * _id is the app-generated, 128-bit-random conversation id (see
 * conversation-id.ts's generateConversationId()), not an auto ObjectId -
 * this IS the id the API returns and that round-trips in later requests,
 * same reasoning TenantDocument's own doc comment gives for using the
 * tenant slug directly as _id.
 */
export interface ConversationDocument {
  _id: string;
  tenantId: string;
  /** null for an anonymous (no verified identity) conversation - never a reason to treat it as belonging to any identified customer. */
  customerRef: string | null;
  status: ConversationStatus;
  messageCount: number;
  createdAt: Date;
  updatedAt: Date;
}

export const ConversationSchema = new Schema<ConversationDocument>(
  {
    _id: { type: String, required: true, match: GENERIC_ID_PATTERN },
    tenantId: { type: String, required: true, index: true },
    customerRef: { type: String, default: null },
    status: { type: String, required: true, enum: ['open', 'closed'], default: 'open' },
    messageCount: { type: Number, required: true, default: 0 },
  },
  { collection: 'conversations', timestamps: { createdAt: true, updatedAt: true } },
);

// _id is already the (globally unique, unguessable) primary key - a lookup
// by id alone is already O(1); tenantId is re-checked in application code
// on the single returned document (defense in depth), not via a compound
// index, since _id is never guessable enough for that check to matter for
// performance. This index is for Milestone 5's admin console conversation
// list, scoped per tenant/customer.
ConversationSchema.index({ tenantId: 1, customerRef: 1 });
