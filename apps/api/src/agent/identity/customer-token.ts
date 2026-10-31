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

export interface CustomerTokenPayload {
  customerRef: string;
  /** Epoch ms. */
  expiresAt: number;
  /** Which of the tenant's public keys (by rotation version) signed this token - lets a tenant rotate keys without invalidating tokens already issued under an older, still-valid key. */
  keyVersion: number;
}

export type VerifyCustomerTokenErrorCode =
  | 'MALFORMED'
  | 'UNKNOWN_KEY_VERSION'
  | 'INVALID_SIGNATURE'
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
    typeof (raw as Record<string, unknown>).customerRef !== 'string' ||
    typeof (raw as Record<string, unknown>).expiresAt !== 'number' ||
    typeof (raw as Record<string, unknown>).keyVersion !== 'number'
  ) {
    return undefined;
  }
  const { customerRef, expiresAt, keyVersion } = raw as CustomerTokenPayload;
  return { customerRef, expiresAt, keyVersion };
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
 * forged customerRef/expiresAt would otherwise have been "valid-shaped":
 * 1. Structural/decode/shape (MALFORMED) - doesn't touch field semantics.
 * 2. Resolve the public key for the claimed keyVersion (UNKNOWN_KEY_VERSION)
 *    - this only reveals whether a key version exists, not whether the
 *    rest of the payload is otherwise well-formed.
 * 3. Verify the signature itself (INVALID_SIGNATURE) - covers a tampered
 *    payload, a truncated/garbage signature, and a token signed with the
 *    wrong key, all indistinguishably (deliberately - distinguishing them
 *    would itself be a signal).
 * Only once the signature verifies does the function look at customerRef
 * format/length or either expiry check - at that point the payload is
 * known-authentic, so there's no side-channel concern left.
 *
 * Never echoes the token, the signature, or any key material in an error
 * message - every error message below is a fixed string.
 */
export function verifyCustomerToken(
  token: string,
  lookupPublicKey: (keyVersion: number) => string | undefined,
  clock: () => Date,
  options: { maxLifetimeMs?: number } = {},
): VerifyCustomerTokenOutcome {
  const maxLifetimeMs = options.maxLifetimeMs ?? CUSTOMER_TOKEN_MAX_LIFETIME_MS;

  const parts = token.split('.');
  if (parts.length !== 2) {
    return { ok: false, error: { code: 'MALFORMED', message: 'Token is not in the expected two-part format.' } };
  }
  const [payloadB64, signatureB64] = parts;

  const payload = parsePayload(payloadB64);
  if (!payload) {
    return { ok: false, error: { code: 'MALFORMED', message: 'Token payload could not be decoded or did not match the expected shape.' } };
  }

  const publicKeyX = lookupPublicKey(payload.keyVersion);
  if (!publicKeyX) {
    return { ok: false, error: { code: 'UNKNOWN_KEY_VERSION', message: 'No public key is registered for this token\'s key version.' } };
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

  if (!GENERIC_ID_PATTERN.test(payload.customerRef)) {
    return { ok: false, error: { code: 'CUSTOMER_REF_INVALID', message: 'customerRef is missing, oversized, or not a valid id shape.' } };
  }

  const now = clock().getTime();
  if (payload.expiresAt <= now) {
    return { ok: false, error: { code: 'EXPIRED', message: 'Token has expired.' } };
  }
  if (payload.expiresAt - now > maxLifetimeMs) {
    return { ok: false, error: { code: 'EXPIRY_TOO_FAR', message: 'Token remaining validity window exceeds the maximum allowed lifetime.' } };
  }

  return { ok: true, payload };
}
