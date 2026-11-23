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

// Stage 1c, item 2 - serves ConversationRepository.list()'s own
// `{tenantId, createdAt: -1, _id: -1}` sort/cursor predicate (the admin
// console's conversation list). An optional `status` filter is applied
// on top of this index's scan rather than earning its own compound index -
// this project's scale (a free-tier M0 cluster, a portfolio demo's worth
// of conversations) doesn't justify a second index just for that one
// optional filter, same "keep it simple at this scale" call the rest of
// this project's indexing already makes.
ConversationSchema.index({ tenantId: 1, createdAt: -1 });
