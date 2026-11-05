import { generateKeyPairSync, KeyObject } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  CLOCK_SKEW_ALLOWANCE_MS,
  CUSTOMER_TOKEN_MAX_LIFETIME_MS,
  CustomerTokenPayload,
  signCustomerToken,
  verifyCustomerToken,
} from './customer-token';

function makeKeyPair(): { privateKey: KeyObject; publicKeyX: string } {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const jwk = publicKey.export({ format: 'jwk' }) as { x: string };
  return { privateKey, publicKeyX: jwk.x };
}

const NOW = new Date('2026-10-31T12:00:00.000Z');
const clock = () => NOW;
const TENANT = 'acme';

function makePayload(overrides: Partial<CustomerTokenPayload> = {}): CustomerTokenPayload {
  return { tenantId: TENANT, customerRef: 'cust_1', expiresAt: NOW.getTime() + 60_000, kid: 1, ...overrides };
}

describe('signCustomerToken / verifyCustomerToken', () => {
  it('verifies a freshly signed, valid token', () => {
    const { privateKey, publicKeyX } = makeKeyPair();
    const token = signCustomerToken(makePayload(), privateKey);

    const result = verifyCustomerToken(token, TENANT, (_t, kid) => (kid === 1 ? publicKeyX : undefined), clock);

    expect(result).toEqual({ ok: true, payload: makePayload() });
  });

  it('passes the caller\'s expectedTenantId (never the payload\'s own claim) into the key lookup', () => {
    const { privateKey, publicKeyX } = makeKeyPair();
    const token = signCustomerToken(makePayload({ tenantId: 'attacker-claimed-tenant' }), privateKey);

    const lookups: Array<[string, number]> = [];
    const lookupPublicKey = (tenantId: string, kid: number): string | undefined => {
      lookups.push([tenantId, kid]);
      return tenantId === TENANT && kid === 1 ? publicKeyX : undefined;
    };

    verifyCustomerToken(token, TENANT, lookupPublicKey, clock);

    expect(lookups).toEqual([[TENANT, 1]]);
  });

  it('rejects a token with the wrong number of segments (MALFORMED)', () => {
    const result = verifyCustomerToken('only-one-segment', TENANT, () => 'irrelevant', clock);
    expect(result).toEqual({ ok: false, error: { code: 'MALFORMED', message: expect.any(String) } });
  });

  it('rejects a token whose payload is not valid base64url/JSON (MALFORMED)', () => {
    const result = verifyCustomerToken('not-valid-json!!!.sig', TENANT, () => 'irrelevant', clock);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('MALFORMED');
  });

  it('rejects a payload missing a required field (MALFORMED)', () => {
    const badPayloadB64 = Buffer.from(JSON.stringify({ tenantId: TENANT, customerRef: 'cust_1' }), 'utf8').toString('base64url');
    const result = verifyCustomerToken(`${badPayloadB64}.sig`, TENANT, () => 'irrelevant', clock);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('MALFORMED');
  });

  it('rejects an unknown kid before ever looking at the signature', () => {
    const { privateKey } = makeKeyPair();
    const token = signCustomerToken(makePayload({ kid: 99 }), privateKey);
    const result = verifyCustomerToken(token, TENANT, () => undefined, clock);
    expect(result).toEqual({ ok: false, error: { code: 'UNKNOWN_KID', message: expect.any(String) } });
  });

  it('rejects a tampered payload (signature no longer matches)', () => {
    const { privateKey, publicKeyX } = makeKeyPair();
    const token = signCustomerToken(makePayload({ customerRef: 'cust_1' }), privateKey);
    const [, signatureB64] = token.split('.');
    const tamperedPayloadB64 = Buffer.from(JSON.stringify(makePayload({ customerRef: 'cust_2' })), 'utf8').toString('base64url');
    const tamperedToken = `${tamperedPayloadB64}.${signatureB64}`;

    const result = verifyCustomerToken(tamperedToken, TENANT, (_t, kid) => (kid === 1 ? publicKeyX : undefined), clock);
    expect(result).toEqual({ ok: false, error: { code: 'INVALID_SIGNATURE', message: expect.any(String) } });
  });

  it('rejects a truncated signature', () => {
    const { privateKey, publicKeyX } = makeKeyPair();
    const token = signCustomerToken(makePayload(), privateKey);
    const [payloadB64, signatureB64] = token.split('.');
    const truncatedToken = `${payloadB64}.${signatureB64.slice(0, 10)}`;

    const result = verifyCustomerToken(truncatedToken, TENANT, (_t, kid) => (kid === 1 ? publicKeyX : undefined), clock);
    expect(result).toEqual({ ok: false, error: { code: 'INVALID_SIGNATURE', message: expect.any(String) } });
  });

  it('rejects a token signed with the WRONG key (another tenant\'s private key)', () => {
    const { publicKeyX } = makeKeyPair();
    const { privateKey: otherTenantPrivateKey } = makeKeyPair();
    const token = signCustomerToken(makePayload(), otherTenantPrivateKey);

    const result = verifyCustomerToken(token, TENANT, (_t, kid) => (kid === 1 ? publicKeyX : undefined), clock);
    expect(result).toEqual({ ok: false, error: { code: 'INVALID_SIGNATURE', message: expect.any(String) } });
  });

  it('rejects a token correctly signed by the resolved key but whose payload claims a different tenantId (TENANT_MISMATCH)', () => {
    // This only matters if lookupPublicKey is ever (mis)implemented to
    // return the same key for two tenants - verifyCustomerToken still
    // catches the inconsistency as a second, independent layer.
    const { privateKey, publicKeyX } = makeKeyPair();
    const token = signCustomerToken(makePayload({ tenantId: 'other-tenant' }), privateKey);

    const result = verifyCustomerToken(token, TENANT, () => publicKeyX, clock);
    expect(result).toEqual({ ok: false, error: { code: 'TENANT_MISMATCH', message: expect.any(String) } });
  });

  it('rejects an oversized customerRef, even with a valid signature', () => {
    const { privateKey, publicKeyX } = makeKeyPair();
    const token = signCustomerToken(makePayload({ customerRef: 'x'.repeat(65) }), privateKey);

    const result = verifyCustomerToken(token, TENANT, (_t, kid) => (kid === 1 ? publicKeyX : undefined), clock);
    expect(result).toEqual({ ok: false, error: { code: 'CUSTOMER_REF_INVALID', message: expect.any(String) } });
  });

  it('rejects a customerRef with characters outside the generic id shape', () => {
    const { privateKey, publicKeyX } = makeKeyPair();
    const token = signCustomerToken(makePayload({ customerRef: 'cust 1; drop table' }), privateKey);

    const result = verifyCustomerToken(token, TENANT, (_t, kid) => (kid === 1 ? publicKeyX : undefined), clock);
    expect(result).toEqual({ ok: false, error: { code: 'CUSTOMER_REF_INVALID', message: expect.any(String) } });
  });

  it('rejects an expired token', () => {
    const { privateKey, publicKeyX } = makeKeyPair();
    const token = signCustomerToken(makePayload({ expiresAt: NOW.getTime() - CLOCK_SKEW_ALLOWANCE_MS - 1 }), privateKey);

    const result = verifyCustomerToken(token, TENANT, (_t, kid) => (kid === 1 ? publicKeyX : undefined), clock);
    expect(result).toEqual({ ok: false, error: { code: 'EXPIRED', message: expect.any(String) } });
  });

  it('rejects a token expiring EXACTLY at the skew boundary (still expired)', () => {
    const { privateKey, publicKeyX } = makeKeyPair();
    const token = signCustomerToken(makePayload({ expiresAt: NOW.getTime() - CLOCK_SKEW_ALLOWANCE_MS }), privateKey);

    const result = verifyCustomerToken(token, TENANT, (_t, kid) => (kid === 1 ? publicKeyX : undefined), clock);
    expect(result).toEqual({ ok: false, error: { code: 'EXPIRED', message: expect.any(String) } });
  });

  it('accepts a token that expired a moment ago, within the clock-skew allowance', () => {
    const { privateKey, publicKeyX } = makeKeyPair();
    const token = signCustomerToken(makePayload({ expiresAt: NOW.getTime() - CLOCK_SKEW_ALLOWANCE_MS + 1 }), privateKey);

    const result = verifyCustomerToken(token, TENANT, (_t, kid) => (kid === 1 ? publicKeyX : undefined), clock);
    expect(result.ok).toBe(true);
  });

  it('rejects a token whose expiry is further out than the maximum allowed lifetime plus skew allowance', () => {
    const { privateKey, publicKeyX } = makeKeyPair();
    const token = signCustomerToken(
      makePayload({ expiresAt: NOW.getTime() + CUSTOMER_TOKEN_MAX_LIFETIME_MS + CLOCK_SKEW_ALLOWANCE_MS + 1 }),
      privateKey,
    );

    const result = verifyCustomerToken(token, TENANT, (_t, kid) => (kid === 1 ? publicKeyX : undefined), clock);
    expect(result).toEqual({ ok: false, error: { code: 'EXPIRY_TOO_FAR', message: expect.any(String) } });
  });

  it('accepts a token whose expiry is exactly at the maximum-lifetime-plus-skew boundary', () => {
    const { privateKey, publicKeyX } = makeKeyPair();
    const token = signCustomerToken(
      makePayload({ expiresAt: NOW.getTime() + CUSTOMER_TOKEN_MAX_LIFETIME_MS + CLOCK_SKEW_ALLOWANCE_MS }),
      privateKey,
    );

    const result = verifyCustomerToken(token, TENANT, (_t, kid) => (kid === 1 ? publicKeyX : undefined), clock);
    expect(result.ok).toBe(true);
  });

  it('honors a custom maxLifetimeMs and clockSkewAllowanceMs override', () => {
    const { privateKey, publicKeyX } = makeKeyPair();
    const token = signCustomerToken(makePayload({ expiresAt: NOW.getTime() + 5000 }), privateKey);

    const result = verifyCustomerToken(token, TENANT, (_t, kid) => (kid === 1 ? publicKeyX : undefined), clock, {
      maxLifetimeMs: 1000,
      clockSkewAllowanceMs: 0,
    });
    expect(result).toEqual({ ok: false, error: { code: 'EXPIRY_TOO_FAR', message: expect.any(String) } });
  });

  it('supports key rotation - a token signed under an older still-registered kid verifies', () => {
    const { privateKey: oldKey, publicKeyX: oldPublicKeyX } = makeKeyPair();
    const { publicKeyX: newPublicKeyX } = makeKeyPair();
    const token = signCustomerToken(makePayload({ kid: 1 }), oldKey);

    const lookupPublicKey = (_t: string, kid: number) => (kid === 1 ? oldPublicKeyX : kid === 2 ? newPublicKeyX : undefined);
    const result = verifyCustomerToken(token, TENANT, lookupPublicKey, clock);
    expect(result.ok).toBe(true);
  });

  it('never echoes the token or key material in any error message', () => {
    const secretLookingToken = 'bogus.sk_should_never_appear_anywhere_in_errors';
    const result = verifyCustomerToken(secretLookingToken, TENANT, () => 'irrelevant', clock);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).not.toContain(secretLookingToken);
      expect(result.error.message).not.toContain('sk_should_never_appear_anywhere_in_errors');
    }
  });
});
