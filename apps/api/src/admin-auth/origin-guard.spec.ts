import { describe, expect, it } from 'vitest';
import { checkOriginForStateChange } from './origin-guard';

const ALLOWED = ['https://admin.supportpilot.example'];

describe('checkOriginForStateChange (item 4)', () => {
  it('rejects a cross-site Sec-Fetch-Site, regardless of Origin', () => {
    expect(checkOriginForStateChange({ secFetchSite: 'cross-site', origin: ALLOWED[0] }, ALLOWED)).toMatchObject({ ok: false });
  });

  it('rejects an Origin that is present but not in the allowlist', () => {
    expect(checkOriginForStateChange({ origin: 'https://evil.example' }, ALLOWED)).toMatchObject({ ok: false });
  });

  it('allows a matching Origin with no Sec-Fetch-Site at all', () => {
    expect(checkOriginForStateChange({ origin: ALLOWED[0] }, ALLOWED)).toEqual({ ok: true });
  });

  it('allows same-site/same-origin Sec-Fetch-Site values', () => {
    expect(checkOriginForStateChange({ secFetchSite: 'same-origin' }, ALLOWED)).toEqual({ ok: true });
    expect(checkOriginForStateChange({ secFetchSite: 'same-site' }, ALLOWED)).toEqual({ ok: true });
    expect(checkOriginForStateChange({ secFetchSite: 'none' }, ALLOWED)).toEqual({ ok: true });
  });

  it('allows a request with NEITHER header at all (a non-browser caller never sends either)', () => {
    expect(checkOriginForStateChange({}, ALLOWED)).toEqual({ ok: true });
  });

  it('with an empty allowlist, any PRESENT Origin is rejected - fails closed, never open', () => {
    expect(checkOriginForStateChange({ origin: 'https://anything.example' }, [])).toMatchObject({ ok: false });
  });
});
