/**
 * Peeks at a customer token's `kid` claim WITHOUT verifying the signature -
 * never trust the result for anything except choosing which public key to
 * fetch before calling `resolveIdentity`/`verifyCustomerToken`
 * (agent/identity/customer-token.ts), both of which require a SYNCHRONOUS
 * `lookupPublicKey`, while `CustomerPublicKeyRepository.findActive` is
 * necessarily async (a database read). This lets the chat service do the
 * one async lookup it actually needs - for the one `kid` the token itself
 * claims - BEFORE calling the synchronous verification path, instead of
 * either changing that path's signature or prefetching every active key
 * for the tenant on every request.
 *
 * Duplicates customer-token.ts's own minimal decode (never the signature
 * check, never field validation beyond what's needed to extract `kid`) -
 * deliberately not imported from there, since that module's own decode is
 * intentionally private/unexported: this function must never be mistaken
 * for - or used as a shortcut around - real verification. A malformed or
 * tampered token simply yields `undefined` here, and verifyCustomerToken
 * re-parses and re-validates the real payload fully and independently;
 * this function being "fooled" by a garbage token has no security
 * consequence, since nothing here is ever trusted.
 */
export function peekUnverifiedKid(token: string): number | undefined {
  const [payloadB64] = token.split('.');
  if (!payloadB64) {
    return undefined;
  }
  try {
    const raw = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
    return typeof raw === 'object' && raw !== null && typeof raw.kid === 'number' ? raw.kid : undefined;
  } catch {
    return undefined;
  }
}
