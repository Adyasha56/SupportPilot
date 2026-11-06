import { describe, expect, it } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import { signCustomerToken } from '../agent/identity/customer-token';
import { peekUnverifiedKid } from './unverified-kid';

describe('peekUnverifiedKid', () => {
  it('extracts the real kid from a well-formed token', () => {
    const { privateKey } = generateKeyPairSync('ed25519');
    const token = signCustomerToken({ tenantId: 'acme', customerRef: 'cust_1', expiresAt: Date.now() + 1000, kid: 7 }, privateKey);
    expect(peekUnverifiedKid(token)).toBe(7);
  });

  it('returns undefined for a token with no dot separator', () => {
    expect(peekUnverifiedKid('not-a-token')).toBeUndefined();
  });

  it('returns undefined for a payload that is not valid base64url JSON', () => {
    expect(peekUnverifiedKid('not-valid-base64url!!!.signature')).toBeUndefined();
  });

  it('returns undefined when kid is missing or the wrong type', () => {
    const payload = Buffer.from(JSON.stringify({ tenantId: 'acme', customerRef: 'cust_1', expiresAt: 1 })).toString('base64url');
    expect(peekUnverifiedKid(`${payload}.sig`)).toBeUndefined();

    const badKidPayload = Buffer.from(JSON.stringify({ kid: 'not-a-number' })).toString('base64url');
    expect(peekUnverifiedKid(`${badKidPayload}.sig`)).toBeUndefined();
  });

  it('is unaffected by signature tampering - it never checks the signature at all', () => {
    const { privateKey } = generateKeyPairSync('ed25519');
    const token = signCustomerToken({ tenantId: 'acme', customerRef: 'cust_1', expiresAt: Date.now() + 1000, kid: 3 }, privateKey);
    const [payloadB64] = token.split('.');
    const tamperedToken = `${payloadB64}.not-the-real-signature`;
    expect(peekUnverifiedKid(tamperedToken)).toBe(3);
  });
});
