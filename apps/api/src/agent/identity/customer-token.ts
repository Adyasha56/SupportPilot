import { createPublicKey, KeyObject, sign, verify } from 'node:crypto';
import { GENERIC_ID_PATTERN } from '@supportpilot/shared';

/**
 * DECISION: Ed25519 (asymmetric), not HMAC-SHA256 (symmetric) - superseding
 * the HMAC sketch in an earlier revision of PROJECT.md's Agent loop design.
 * Recorded in full in docs/learning-notes.md; summarized here since it's
 * the reason this module looks the way it does:
 *
 * With HMAC, the server and the signing company share ONE secret - the
 * server must hold it in a form it can use to VERIFY, which for HMAC means
 * holding the real secret back (encrypted at rest, decrypted into memory
 * per verification), plus a server-side master key to decrypt it. With
 * Ed25519, the company holds a PRIVATE key and signs; the server only ever
 * needs the PUBLIC key to verify - which is not secret material at all. A
 * compromised server database under Ed25519 only exposes public keys
 * (no replay-elsewhere risk, nothing to decrypt, no master key to manage);
 * under HMAC it exposes every tenant's real shared secret. This module
 * therefore never touches a private key or any encrypted-secret-at-rest
 * machinery at all - `lookupPublicKey` below resolves to a PLAIN public
 * key, safe to store in plain text.
 */

export const CUSTOMER_TOKEN_MAX_LIFETIME_MS = 15 * 60 * 1000;

/** Tolerates minor clock drift between the signing company's server and ours - applied symmetrically to both the EXPIRED and EXPIRY_TOO_FAR checks (see verifyCustomerToken's own doc comment for why both directions). 30s is generous for NTP-synced servers without meaningfully widening the token's real usable window. */
export const CLOCK_SKEW_ALLOWANCE_MS = 30 * 1000;

export interface CustomerTokenPayload {
  /** Bound into the signed payload itself - verification requires this to equal the request's own authenticated tenant, never trusted merely because the signature happens to verify (see verifyCustomerToken's doc comment for why the key lookup, not this field, is what actually enforces isolation). */
  tenantId: string;
  customerRef: string;
  /** Epoch ms. */
  expiresAt: number;
  /** Which of the tenant's public keys signed this token - lets a tenant rotate keys without invalidating tokens already issued under an older, still-registered key. */
  kid: number;
}

export type VerifyCustomerTokenErrorCode =
  | 'MALFORMED'
  | 'UNKNOWN_KID'
  | 'INVALID_SIGNATURE'
  | 'TENANT_MISMATCH'
  | 'CUSTOMER_REF_INVALID'
  | 'EXPIRED'
  | 'EXPIRY_TOO_FAR';

export interface VerifyCustomerTokenError {
  code: VerifyCustomerTokenErrorCode;
  /** Never echoes the token or any key material - see each branch below. */
  message: string;
}

export type VerifyCustomerTokenOutcome = { ok: true; payload: CustomerTokenPayload } | { ok: false; error: VerifyCustomerTokenError };

function toBuffer(payloadB64: string): Buffer {
  return Buffer.from(payloadB64, 'utf8');
}

/**
 * Signs a payload with the COMPANY's private key - used by the company's
 * own key-generation/signing tooling (see docs/learning-notes.md for a
 * complete standalone example) and by this project's own tests to build
 * valid tokens to verify against. Never called with anything the server
 * itself holds long-term; the server never has a private key.
 *
 * Signs the exact bytes of the base64url-encoded payload STRING - never a
 * re-serialization of the payload object. verifyCustomerToken below
 * verifies against that same substring taken directly from the wire
 * (`token.split('.')[0]`), so the signature is checked against the exact
 * bytes that were actually signed, not against a JSON.stringify() of the
 * decoded object, which could legally differ in key order or whitespace
 * from what was originally signed even for an "equivalent" payload.
 */
export function signCustomerToken(payload: CustomerTokenPayload, privateKey: KeyObject): string {
  const payloadB64 = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const signature = sign(null, toBuffer(payloadB64), privateKey);
  return `${payloadB64}.${signature.toString('base64url')}`;
}

function parsePayload(payloadB64: string): CustomerTokenPayload | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
  } catch {
    return undefined;
  }
  if (
    typeof raw !== 'object' ||
    raw === null ||
    typeof (raw as Record<string, unknown>).tenantId !== 'string' ||
    typeof (raw as Record<string, unknown>).customerRef !== 'string' ||
    typeof (raw as Record<string, unknown>).expiresAt !== 'number' ||
    typeof (raw as Record<string, unknown>).kid !== 'number'
  ) {
    return undefined;
  }
  const { tenantId, customerRef, expiresAt, kid } = raw as CustomerTokenPayload;
  return { tenantId, customerRef, expiresAt, kid };
}

function reconstructPublicKey(publicKeyX: string): KeyObject | undefined {
  try {
    return createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: publicKeyX }, format: 'jwk' });
  } catch {
    return undefined;
  }
}

/**
 * Verifies a token produced by signCustomerToken, in a FIXED order chosen
 * so that nothing about an unverified token's CONTENT is examined before
 * its SIGNATURE is confirmed - an attacker without a real private key
 * should never be able to learn, from the error code alone, whether their
 * forged customerRef/expiresAt/tenantId would otherwise have been
 * "valid-shaped":
 * 1. Structural/decode/shape (MALFORMED) - doesn't touch field semantics.
 * 2. Resolve the public key via `lookupPublicKey(expectedTenantId, payload.kid)`
 *    (UNKNOWN_KID if none is registered) - CRITICALLY, this looks up the
 *    key using `expectedTenantId` (the caller's own already-authenticated
 *    tenant), NEVER `payload.tenantId`. This is what actually enforces
 *    tenant isolation: if the lookup instead trusted the payload's own
 *    unverified tenantId claim, a token genuinely signed for tenant A
 *    could be presented against tenant B's request and get verified
 *    against tenant B's key purely because the attacker said "tenantId:
 *    B" in an unsigned... well, every field here IS signed, but the point
 *    is the lookup must never key off content that hasn't been verified
 *    yet - using the request's own trusted tenantId sidesteps the
 *    question entirely.
 * 3. Verify the signature itself (INVALID_SIGNATURE) - covers a tampered
 *    payload, a truncated/garbage signature, and a token signed with the
 *    wrong key, all indistinguishably (deliberately - distinguishing them
 *    would itself be a signal).
 * Only once the signature verifies does the function look at tenantId
 * equality, customerRef format, or either expiry check - at that point
 * the payload is known-authentic, so there's no side-channel concern
 * left. The tenantId equality check (payload.tenantId === expectedTenantId)
 * is a defense-in-depth consistency check on top of step 2's isolation
 * enforcement, not a substitute for it - it catches a payload whose own
 * self-description disagrees with how it was actually looked up and
 * verified (e.g. a signing mistake on the company's side).
 *
 * `clockSkewAllowanceMs` (default CLOCK_SKEW_ALLOWANCE_MS) is applied to
 * BOTH the EXPIRED and EXPIRY_TOO_FAR checks, symmetrically: a verifier
 * clock running slightly fast must not reject a token the issuer's clock
 * considered still valid (EXPIRED side), and a verifier clock running
 * slightly slow must not reject a token whose expiry the issuer's
 * (possibly slightly-fast) clock legitimately placed right at the maximum
 * lifetime boundary (EXPIRY_TOO_FAR side).
 *
 * Never echoes the token, the signature, or any key material in an error
 * message - every error message below is a fixed string.
 */
export function verifyCustomerToken(
  token: string,
  expectedTenantId: string,
  lookupPublicKey: (tenantId: string, kid: number) => string | undefined,
  clock: () => Date,
  options: { maxLifetimeMs?: number; clockSkewAllowanceMs?: number } = {},
): VerifyCustomerTokenOutcome {
  const maxLifetimeMs = options.maxLifetimeMs ?? CUSTOMER_TOKEN_MAX_LIFETIME_MS;
  const clockSkewAllowanceMs = options.clockSkewAllowanceMs ?? CLOCK_SKEW_ALLOWANCE_MS;

  const parts = token.split('.');
  if (parts.length !== 2) {
    return { ok: false, error: { code: 'MALFORMED', message: 'Token is not in the expected two-part format.' } };
  }
  const [payloadB64, signatureB64] = parts;

  const payload = parsePayload(payloadB64);
  if (!payload) {
    return { ok: false, error: { code: 'MALFORMED', message: 'Token payload could not be decoded or did not match the expected shape.' } };
  }

  const publicKeyX = lookupPublicKey(expectedTenantId, payload.kid);
  if (!publicKeyX) {
    return { ok: false, error: { code: 'UNKNOWN_KID', message: 'No public key is registered for this token\'s kid.' } };
  }

  const publicKey = reconstructPublicKey(publicKeyX);
  let signatureValid = false;
  if (publicKey) {
    try {
      const signature = Buffer.from(signatureB64, 'base64url');
      signatureValid = verify(null, toBuffer(payloadB64), publicKey, signature);
    } catch {
      signatureValid = false;
    }
  }
  if (!signatureValid) {
    return { ok: false, error: { code: 'INVALID_SIGNATURE', message: 'Token signature did not verify.' } };
  }

  if (payload.tenantId !== expectedTenantId) {
    return { ok: false, error: { code: 'TENANT_MISMATCH', message: 'Token was not issued for this tenant.' } };
  }

  if (!GENERIC_ID_PATTERN.test(payload.customerRef)) {
    return { ok: false, error: { code: 'CUSTOMER_REF_INVALID', message: 'customerRef is missing, oversized, or not a valid id shape.' } };
  }

  const now = clock().getTime();
  if (payload.expiresAt + clockSkewAllowanceMs <= now) {
    return { ok: false, error: { code: 'EXPIRED', message: 'Token has expired.' } };
  }
  if (payload.expiresAt - now > maxLifetimeMs + clockSkewAllowanceMs) {
    return { ok: false, error: { code: 'EXPIRY_TOO_FAR', message: 'Token remaining validity window exceeds the maximum allowed lifetime.' } };
  }

  return { ok: true, payload };
}
