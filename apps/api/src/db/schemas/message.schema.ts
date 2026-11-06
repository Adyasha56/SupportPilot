import { Schema, Types } from 'mongoose';

export type MessageRole = 'customer' | 'agent';

export interface MessageDocument {
  _id: Types.ObjectId;
  tenantId: string;
  /** The Conversation's own _id (an app-generated string, not an ObjectId - see conversation.schema.ts). */
  conversationId: string;
  role: MessageRole;
  /** The real customer/agent text - this is what a conversation transcript legitimately stores, unlike AgentRun's own fields (see agent-run.schema.ts's doc comment on what that one deliberately never stores). */
  content: string;
  createdAt: Date;
}

export const MessageSchema = new Schema<MessageDocument>(
  {
    tenantId: { type: String, required: true, index: true },
    conversationId: { type: String, required: true },
    role: { type: String, required: true, enum: ['customer', 'agent'] },
    content: { type: String, required: true },
  },
  { collection: 'messages', timestamps: { createdAt: true, updatedAt: false } },
);

MessageSchema.index({ tenantId: 1, conversationId: 1, createdAt: 1 });
