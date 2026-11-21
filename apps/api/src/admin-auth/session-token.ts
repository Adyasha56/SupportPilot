import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/** 32 random bytes (item 3's explicit size), base64url - the raw value sent to the browser in the cookie, never stored anywhere. Only its hash persists (admin-session.schema.ts). */
export function mintSessionToken(): string {
  return randomBytes(32).toString('base64url');
}

export function hashSessionToken(rawToken: string): string {
  return createHash('sha256').update(rawToken).digest('hex');
}

/** Same defense-in-depth constant-time compare `verifyApiKeyHash` already uses (auth/api-key.service.ts) - the repository's own exact-match lookup is never the SOLE check. */
export function tokensMatch(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'hex');
  const bufB = Buffer.from(b, 'hex');
  if (bufA.length !== bufB.length) {
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}

/** The synchronizer CSRF token (item 4) - a plain random value, never derived from the session token itself (so leaking one can never help forge the other). */
export function mintCsrfToken(): string {
  return randomBytes(32).toString('base64url');
}

/** Constant-time compare for the CSRF token itself - it's not secret in the same sense a session token is (useless without the cookie it's bound to), but comparing it with `===` would still leak timing information for no reason. */
export function csrfTokensMatch(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) {
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}
