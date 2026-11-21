/**
 * Milestone 5, Stage 1b - hand-rolled, deliberately tiny cookie
 * parsing/naming, specifically to avoid adding `cookie-parser` as a new
 * dependency (item 3's "no new dependency unless justified" constraint) -
 * SETTING a cookie needs no extra dependency at all (Express's own
 * `res.cookie()` is a core response method, not something cookie-parser
 * adds); only READING the incoming `Cookie` request header needs this.
 */
export const PRODUCTION_SESSION_COOKIE_NAME = '__Host-sp_session';
/** Deliberately a DIFFERENT name, never the `__Host-` prefix - that prefix is invalid on a cookie without `Secure` (browsers refuse to even set it), so the dev-mode cookie structurally cannot reuse the production name. */
export const DEV_SESSION_COOKIE_NAME = 'sp_session_dev';

export function parseCookieHeader(header: string | undefined): Record<string, string> {
  const result: Record<string, string> = {};
  if (!header) {
    return result;
  }
  for (const pair of header.split(';')) {
    const separatorIndex = pair.indexOf('=');
    if (separatorIndex === -1) {
      continue;
    }
    const name = pair.slice(0, separatorIndex).trim();
    const value = pair.slice(separatorIndex + 1).trim();
    if (name.length === 0) {
      continue;
    }
    try {
      result[name] = decodeURIComponent(value);
    } catch {
      result[name] = value;
    }
  }
  return result;
}

/** Whichever of the two session cookie names is present - never both at once in real operation, but reading both defensively costs nothing. */
export function readSessionCookieValue(cookies: Record<string, string>): string | undefined {
  return cookies[PRODUCTION_SESSION_COOKIE_NAME] ?? cookies[DEV_SESSION_COOKIE_NAME];
}
