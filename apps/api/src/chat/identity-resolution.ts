import { ChatRequest } from '@supportpilot/shared';
import { verifyCustomerToken } from '../agent/identity/customer-token';
import { ApiKeyScope } from '../db/schemas/api-key.schema';

/**
 * Stage 4 amendment A - a customer token that is PRESENT but fails
 * verification for ANY reason (malformed, expired, wrong tenant, unknown
 * kid, tampered signature) is `invalid_token`, never silently collapsed
 * into `anonymous` the way the original Stage 4 plan had it. The caller
 * (chat.controller.ts, Stage 5) maps `invalid_token` to one uniform 401
 * (code INVALID_CUSTOMER_TOKEN, one fixed generic message) - this module
 * itself never distinguishes WHICH verification check failed in its
 * return value, so there is nothing to leak even before the controller's
 * own generic-message mapping. `anonymous` is reserved for a caller that
 * never presented a token at all - that one still proceeds (policy-only).
 */
export type IdentityResolution =
  | { kind: 'identified'; customerRef: string }
  | { kind: 'anonymous' }
  | { kind: 'invalid_token' };

export type LookupPublicKey = (tenantId: string, kid: number) => string | undefined;

/**
 * Resolves the caller's identity from the authenticated scope and the
 * request body - never from an unverified claim. A `public`-scope
 * request's own `customerRef` field is ALWAYS ignored (PROJECT.md's rule:
 * only a `secret`-scope, server-to-server caller may assert a customerRef
 * directly - it is "already fully trusted"). A `secret`-scope caller never
 * needs or uses a customerToken - it already has the stronger, direct
 * trust relationship, so a token on that request (if one were sent) is
 * simply not consulted.
 *
 * Token verification happens here, in pure code with no I/O beyond the
 * injected `lookupPublicKey`/`clock` - callers (chat.service.ts) run this
 * BEFORE any conversation read and before any LLM call, so an invalid
 * token is rejected as cheaply as possible, before any real work starts.
 */
export function resolveIdentity(
  scope: ApiKeyScope,
  request: Pick<ChatRequest, 'customerRef' | 'customerToken'>,
  tenantId: string,
  lookupPublicKey: LookupPublicKey,
  clock: () => Date,
): IdentityResolution {
  if (scope === 'secret') {
    return request.customerRef ? { kind: 'identified', customerRef: request.customerRef } : { kind: 'anonymous' };
  }

  // scope === 'public' - request.customerRef is never consulted here.
  if (!request.customerToken) {
    return { kind: 'anonymous' };
  }

  const verified = verifyCustomerToken(request.customerToken, tenantId, lookupPublicKey, clock);
  if (!verified.ok) {
    return { kind: 'invalid_token' };
  }
  return { kind: 'identified', customerRef: verified.payload.customerRef };
}
