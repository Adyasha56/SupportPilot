import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export const RAW_KEY_PREFIX = 'sk_';
export const KEY_PREFIX_DISPLAY_LENGTH = 8;

/**
 * sk_ + 32 random bytes, base64url-encoded. The raw value is returned once
 * by the CLI that creates it and is never stored or logged anywhere - only
 * its hash and its short display prefix persist.
 */
export function generateRawApiKey(): string {
  return RAW_KEY_PREFIX + randomBytes(32).toString('base64url');
}

export function hashApiKey(rawKey: string): string {
  return createHash('sha256').update(rawKey).digest('hex');
}

export function getKeyPrefix(rawKey: string): string {
  return rawKey.slice(0, KEY_PREFIX_DISPLAY_LENGTH);
}

/**
 * Constant-time comparison on equal-length buffers, used in addition to
 * (not instead of) the repository's own exact-match lookup by hash - belt
 * and suspenders: the authoritative "is this really a match" check always
 * happens in code, not only implicitly trusted from a DB query's equality
 * semantics.
 *
 * SHA-256 without a per-key salt is acceptable here because the input is a
 * 256-bit cryptographically random value, not a human-chosen password: with
 * that much entropy, precomputed rainbow tables and brute-force search are
 * both computationally infeasible regardless of salting, which is exactly
 * the attack salting exists to prevent. A password's much lower, guessable
 * entropy is what makes salting necessary there - it isn't needed to defend
 * an already-unguessable random value.
 */
export function verifyApiKeyHash(candidateHash: string, storedHash: string): boolean {
  const a = Buffer.from(candidateHash, 'hex');
  const b = Buffer.from(storedHash, 'hex');
  if (a.length !== b.length) {
    return false;
  }
  return timingSafeEqual(a, b);
}
