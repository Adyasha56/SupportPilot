import { generateKeyPairSync, KeyObject } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { CustomerTokenPayload, signCustomerToken } from '../agent/identity/customer-token';
import { resolveIdentity } from './identity-resolution';

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

describe('resolveIdentity', () => {
  describe('secret scope', () => {
    it('trusts a provided customerRef directly - no token involved at all', () => {
      const result = resolveIdentity('secret', { customerRef: 'cust_1' }, TENANT, () => undefined, clock);
      expect(result).toEqual({ kind: 'identified', customerRef: 'cust_1' });
    });

    it('is anonymous when no customerRef is given', () => {
      const result = resolveIdentity('secret', {}, TENANT, () => undefined, clock);
      expect(result).toEqual({ kind: 'anonymous' });
    });

    it('never consults a customerToken, even if one is present', () => {
      const { privateKey } = makeKeyPair();
      const token = signCustomerToken(makePayload(), privateKey);
      const lookupPublicKey = (): string => {
        throw new Error('must never be called for a secret-scope request');
      };

      const result = resolveIdentity('secret', { customerRef: 'cust_1', customerToken: token }, TENANT, lookupPublicKey, clock);
      expect(result).toEqual({ kind: 'identified', customerRef: 'cust_1' });
    });
  });

  describe('public scope', () => {
    it('is anonymous when no customerToken is given', () => {
      const result = resolveIdentity('public', {}, TENANT, () => undefined, clock);
      expect(result).toEqual({ kind: 'anonymous' });
    });

    it('ignores a customerRef in the body entirely - only a verified token can identify a public caller', () => {
      const result = resolveIdentity('public', { customerRef: 'cust_1' }, TENANT, () => undefined, clock);
      expect(result).toEqual({ kind: 'anonymous' });
    });

    it('a valid token for this tenant resolves to the signed customerRef', () => {
      const { privateKey, publicKeyX } = makeKeyPair();
      const token = signCustomerToken(makePayload(), privateKey);

      const result = resolveIdentity('public', { customerToken: token }, TENANT, (_t, kid) => (kid === 1 ? publicKeyX : undefined), clock);
      expect(result).toEqual({ kind: 'identified', customerRef: 'cust_1' });
    });

    it.each([
      ['a malformed token', 'not-a-real-token'],
    ])('amendment A: %s is invalid_token, never a silent fallback to anonymous', (_label, token) => {
      const result = resolveIdentity('public', { customerToken: token }, TENANT, () => undefined, clock);
      expect(result).toEqual({ kind: 'invalid_token' });
    });

    it('amendment A: an expired token is invalid_token, never anonymous', () => {
      const { privateKey, publicKeyX } = makeKeyPair();
      const token = signCustomerToken(makePayload({ expiresAt: NOW.getTime() - 60_000 }), privateKey);

      const result = resolveIdentity('public', { customerToken: token }, TENANT, (_t, kid) => (kid === 1 ? publicKeyX : undefined), clock);
      expect(result).toEqual({ kind: 'invalid_token' });
    });

    it('amendment A: a token for a different tenant is invalid_token, never anonymous', () => {
      const { privateKey, publicKeyX } = makeKeyPair();
      const token = signCustomerToken(makePayload({ tenantId: 'widgetco' }), privateKey);

      const result = resolveIdentity(
        'public',
        { customerToken: token },
        TENANT,
        (t, kid) => (t === 'widgetco' && kid === 1 ? publicKeyX : undefined),
        clock,
      );
      expect(result).toEqual({ kind: 'invalid_token' });
    });

    it('amendment A: an unknown kid is invalid_token, never anonymous', () => {
      const { privateKey } = makeKeyPair();
      const token = signCustomerToken(makePayload({ kid: 999 }), privateKey);

      const result = resolveIdentity('public', { customerToken: token }, TENANT, () => undefined, clock);
      expect(result).toEqual({ kind: 'invalid_token' });
    });

    it('amendment A: a tampered signature is invalid_token, never anonymous', () => {
      const { privateKey, publicKeyX } = makeKeyPair();
      const token = signCustomerToken(makePayload(), privateKey);
      const [payloadB64] = token.split('.');
      const tampered = `${payloadB64}.${'a'.repeat(86)}`;

      const result = resolveIdentity('public', { customerToken: tampered }, TENANT, (_t, kid) => (kid === 1 ? publicKeyX : undefined), clock);
      expect(result).toEqual({ kind: 'invalid_token' });
    });

    it('every invalid_token case looks identical regardless of cause - nothing distinguishes them in the return value', () => {
      const { privateKey, publicKeyX } = makeKeyPair();
      const expired = signCustomerToken(makePayload({ expiresAt: NOW.getTime() - 60_000 }), privateKey); // well beyond CLOCK_SKEW_ALLOWANCE_MS
      const wrongTenant = signCustomerToken(makePayload({ tenantId: 'widgetco' }), privateKey);
      const lookupPublicKey = (_t: string, kid: number): string | undefined => (kid === 1 ? publicKeyX : undefined);

      const results = [
        resolveIdentity('public', { customerToken: 'garbage' }, TENANT, lookupPublicKey, clock),
        resolveIdentity('public', { customerToken: expired }, TENANT, lookupPublicKey, clock),
        resolveIdentity('public', { customerToken: wrongTenant }, TENANT, lookupPublicKey, clock),
      ];

      for (const result of results) {
        expect(result).toEqual({ kind: 'invalid_token' });
      }
    });
  });
});
