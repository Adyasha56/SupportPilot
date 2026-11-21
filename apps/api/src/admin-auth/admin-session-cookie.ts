import { DEV_SESSION_COOKIE_NAME, PRODUCTION_SESSION_COOKIE_NAME } from './cookie-utils';

export interface ResolvedSessionCookie {
  name: string;
  secure: boolean;
  httpOnly: true;
  sameSite: 'strict';
  path: '/';
}

/**
 * Milestone 5, Stage 1b, item 3 - BOTH `devCookieEnabled` AND
 * `nodeEnv !== 'production'` must hold for the non-Secure dev cookie to
 * ever be issued; production mode wins even if the dev flag is accidentally
 * left on (same double-gate discipline this project already uses for the
 * SSRF private-network exception, PROJECT.md's amendment G). `secure:
 * false` is the ENTIRE reason this cookie needs a different name at all -
 * `__Host-` is invalid (browsers refuse to set it) on any cookie without
 * `Secure`.
 */
export function resolveSessionCookie(devCookieEnabled: boolean, nodeEnv: string | undefined): ResolvedSessionCookie {
  const useDev = devCookieEnabled && nodeEnv !== 'production';
  return useDev
    ? { name: DEV_SESSION_COOKIE_NAME, secure: false, httpOnly: true, sameSite: 'strict', path: '/' }
    : { name: PRODUCTION_SESSION_COOKIE_NAME, secure: true, httpOnly: true, sameSite: 'strict', path: '/' };
}

/** Both possible cookie names - logout clears both defensively, regardless of which mode issued the one actually present, so a stale cookie from a mode switch (dev -> prod, or vice versa) is never left behind. */
export const ALL_SESSION_COOKIE_NAMES = [PRODUCTION_SESSION_COOKIE_NAME, DEV_SESSION_COOKIE_NAME];
