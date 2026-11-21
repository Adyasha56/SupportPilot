import { describe, expect, it } from 'vitest';
import { DEV_SESSION_COOKIE_NAME, PRODUCTION_SESSION_COOKIE_NAME } from './cookie-utils';
import { resolveSessionCookie } from './admin-session-cookie';

describe('resolveSessionCookie (item 3 - cookie attributes in both modes)', () => {
  it('issues the production __Host- cookie, Secure, when the dev flag is off', () => {
    const cookie = resolveSessionCookie(false, 'production');
    expect(cookie).toEqual({ name: PRODUCTION_SESSION_COOKIE_NAME, secure: true, httpOnly: true, sameSite: 'strict', path: '/' });
  });

  it('issues the production cookie even when the dev flag is ON, as long as NODE_ENV is production - the double gate', () => {
    const cookie = resolveSessionCookie(true, 'production');
    expect(cookie.name).toBe(PRODUCTION_SESSION_COOKIE_NAME);
    expect(cookie.secure).toBe(true);
  });

  it('issues the production cookie when NODE_ENV is not production but the dev flag is off', () => {
    const cookie = resolveSessionCookie(false, 'development');
    expect(cookie.name).toBe(PRODUCTION_SESSION_COOKIE_NAME);
    expect(cookie.secure).toBe(true);
  });

  it('issues the DIFFERENTLY-NAMED, non-Secure dev cookie only when BOTH conditions hold', () => {
    const cookie = resolveSessionCookie(true, 'development');
    expect(cookie).toEqual({ name: DEV_SESSION_COOKIE_NAME, secure: false, httpOnly: true, sameSite: 'strict', path: '/' });
  });

  it('the dev cookie never uses the __Host- prefix (invalid without Secure)', () => {
    const cookie = resolveSessionCookie(true, 'test');
    expect(cookie.name.startsWith('__Host-')).toBe(false);
  });
});
