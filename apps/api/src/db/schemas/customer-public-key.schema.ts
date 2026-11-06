import { Schema, Types } from 'mongoose';

export type CustomerPublicKeyStatus = 'active' | 'retired';

/**
 * Stores PUBLIC keys only, in plain text - safe to, by design (see
 * apps/api/src/agent/identity/customer-token.ts's own doc comment on why
 * Ed25519 was chosen over HMAC: the server never holds a private key or
 * any encrypted-secret-at-rest material for this). The company generates
 * its own Ed25519 keypair and gives us only the public half via
 * register-customer-key.ts.
 */
export interface CustomerPublicKeyDocument {
  _id: Types.ObjectId;
  tenantId: string;
  kid: number;
  /** The JWK 'x' coordinate (base64url) - the exact shape verifyCustomerToken's reconstructPublicKey expects. */
  publicKeyX: string;
  status: CustomerPublicKeyStatus;
  createdAt: Date;
}

export const CustomerPublicKeySchema = new Schema<CustomerPublicKeyDocument>(
  {
    tenantId: { type: String, required: true, index: true },
    kid: { type: Number, required: true },
    publicKeyX: { type: String, required: true },
    status: { type: String, required: true, enum: ['active', 'retired'], default: 'active' },
  },
  { collection: 'customerPublicKeys', timestamps: { createdAt: true, updatedAt: false } },
);

// The exact lookup verifyCustomerToken needs: (tenantId, kid) -> public key.
// A tenant is never expected to reuse a kid across a retire/reissue cycle
// (register-customer-key.ts refuses to insert a duplicate), so this is
// safe as a unique index, not just a lookup index.
CustomerPublicKeySchema.index({ tenantId: 1, kid: 1 }, { unique: true });
// Enforces the max-active-keys-per-tenant cap efficiently.
CustomerPublicKeySchema.index({ tenantId: 1, status: 1 });
