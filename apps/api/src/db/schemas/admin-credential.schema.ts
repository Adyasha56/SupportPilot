import { Schema } from 'mongoose';
import { TENANT_ID_PATTERN } from '@supportpilot/shared';

/**
 * Milestone 5, Stage 1b - `_id` is the tenant slug itself (same convention
 * `TenantDocument` already uses), which structurally guarantees "one admin
 * credential per tenant" (item 1) - a second `set-admin-credential` run
 * for the same tenant REPLACES this one document's `passwordHash`/`salt`
 * rather than ever creating a second credential. `email` is a SEPARATE
 * field with its own unique index (db-ensure-indexes.ts) - global
 * uniqueness across every tenant, normalized to lowercase before storage
 * (never relying on a case-insensitive index collation), because login
 * looks up a credential BY EMAIL ALONE (the tenant isn't known yet at that
 * point in the request - see admin-login.service.ts).
 */
export interface AdminCredentialDocument {
  _id: string;
  email: string;
  /** Self-describing scrypt string (algorithm + N/r/p/keylen + salt + derived key, all base64) - see password-hash.ts's own serializeHash/parseHash. Verification always reads parameters FROM this string, never from current settings, so a later settings change never breaks an existing credential. */
  passwordHash: string;
  failedAttempts: number;
  lockedUntil: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export const AdminCredentialSchema = new Schema<AdminCredentialDocument>(
  {
    _id: { type: String, required: true, match: TENANT_ID_PATTERN },
    email: { type: String, required: true },
    passwordHash: { type: String, required: true },
    failedAttempts: { type: Number, required: true, default: 0 },
    lockedUntil: { type: Date, default: null },
  },
  { collection: 'adminCredentials', timestamps: { createdAt: true, updatedAt: true } },
);

// Milestone 5, Stage 1b, item 8 - email is unique GLOBALLY (never per-tenant) - login looks up a
// credential by email alone, before any tenant is known. Managed by db:ensure-indexes, like every
// other index in this project - never autoIndex at boot.
AdminCredentialSchema.index({ email: 1 }, { unique: true });
