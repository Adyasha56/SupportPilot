/**
 * Milestone 5, Stage 1b, item 4 - defense in depth for cookie-authenticated
 * state-changing requests, on top of the CSRF synchronizer token (the
 * real defense - this is a cheap, early rejection for the common case,
 * same "a speed bump, not THE security boundary" category as the existing
 * public-key Origin check in api-key.guard.ts, just applied here as a
 * SECOND layer alongside a real one rather than the only one).
 *
 * Two independent checks, either one failing is a rejection:
 *   1. `Sec-Fetch-Site: cross-site` - sent by every modern browser on a
 *      fetch/XHR/form submission that crosses a site boundary; a reliable,
 *      browser-enforced signal that costs nothing to check.
 *   2. An `Origin` header that IS present but does not match one of this
 *      server's own configured origins. Its ABSENCE is never itself a
 *      rejection (some legitimate same-origin requests omit it, and a
 *      non-browser caller never sends either header - cookie auth is
 *      pointless for a non-browser caller anyway, since nothing but a
 *      browser holds the cookie jar).
 */
export interface OriginCheckRequest {
  secFetchSite?: string;
  origin?: string;
}

export function checkOriginForStateChange(request: OriginCheckRequest, allowedOrigins: string[]): { ok: boolean; reason?: string } {
  if (request.secFetchSite === 'cross-site') {
    return { ok: false, reason: 'cross-site Sec-Fetch-Site' };
  }
  if (request.origin !== undefined && !allowedOrigins.includes(request.origin)) {
    return { ok: false, reason: 'Origin not in the configured allowlist' };
  }
  return { ok: true };
}
