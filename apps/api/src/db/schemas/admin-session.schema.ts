import { Schema } from 'mongoose';

/**
 * Milestone 5, Stage 1b - the raw session token never reaches storage, only
 * its SHA-256 (`tokenHash`) - same "store the hash, never the secret"
 * discipline `ApiKey.hash` already follows. `csrfToken` is NOT secret in
 * the same sense (it's useless without the session cookie it's bound to),
 * but still only ever lives server-side here - never a readable cookie
 * (the synchronizer token pattern, item 4). `idleTimeoutMs` is captured at
 * CREATION time (not re-read from live settings on every request) so a
 * later settings change can never retroactively shrink/extend an
 * already-issued session's own idle budget mid-session.
 */
export interface AdminSessionDocument {
  _id: unknown;
  tenantId: string;
  /** The AdminCredential's own `_id` - today always equal to `tenantId` (one credential per tenant), kept as its own field for forward compatibility if that 1:1 relationship ever changes. */
  principalId: string;
  tokenHash: string;
  csrfToken: string;
  createdAt: Date;
  lastSeenAt: Date;
  absoluteExpiresAt: Date;
  idleTimeoutMs: number;
}

export const AdminSessionSchema = new Schema<AdminSessionDocument>(
  {
    tenantId: { type: String, required: true },
    principalId: { type: String, required: true },
    tokenHash: { type: String, required: true },
    csrfToken: { type: String, required: true },
    lastSeenAt: { type: Date, required: true },
    absoluteExpiresAt: { type: Date, required: true },
    idleTimeoutMs: { type: Number, required: true },
  },
  { collection: 'adminSessions', timestamps: { createdAt: true, updatedAt: false } },
);

// Lookups during AdminAuthGuard's own session resolution, and bulk
// revocation when a credential's password changes (set-admin-credential.ts,
// item 1) - both keyed by principalId, scoped by tenantId for defense in depth.
AdminSessionSchema.index({ tenantId: 1, principalId: 1 });

// The raw session token's hash must be unique - two sessions can never share a tokenHash (an
// astronomically unlikely but not impossible collision of 32 random bytes would otherwise let
// one session's lookup return a DIFFERENT principal's row). AdminAuthGuard looks up by this
// field exclusively.
AdminSessionSchema.index({ tokenHash: 1 }, { unique: true });

// TTL on an ABSOLUTE timestamp, not a relative retention window - expireAfterSeconds: 0 means
// "delete once the CURRENT time passes the value already stored in this field", which is exactly
// absoluteExpiresAt's own meaning (already computed as `now + sessionAbsoluteLifetimeMs` at
// session creation). Deliberately NOT derived from CHAT_RETENTION_DAYS or any other
// retention-days setting - db-ensure-indexes.ts passes this one as a fixed literal 0, never a
// configurable value, since any other number here would be semantically wrong for this field.
AdminSessionSchema.index({ absoluteExpiresAt: 1 }, { expireAfterSeconds: 0 });
