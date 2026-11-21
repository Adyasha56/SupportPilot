import { describe, expect, it } from 'vitest';
import { getDummyHash, hashPassword, parseHash, SCRYPT_KEYLEN, SCRYPT_N, SCRYPT_P, SCRYPT_R, serializeHash, verifyDummyHash, verifyPasswordHash } from './password-hash';

describe('password-hash (item 2)', () => {
  it('hashes and verifies a real password round-trip', async () => {
    const hash = await hashPassword('a-correct-password-123');
    expect(await verifyPasswordHash('a-correct-password-123', hash)).toBe(true);
  });

  it('a wrong password never verifies', async () => {
    const hash = await hashPassword('a-correct-password-123');
    expect(await verifyPasswordHash('a-completely-different-password', hash)).toBe(false);
  });

  it('the stored hash string self-describes its own scrypt parameters (N, r, p, keylen)', async () => {
    const hash = await hashPassword('whatever-password');
    const parsed = parseHash(hash);
    expect(parsed).toMatchObject({ n: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P, keylen: SCRYPT_KEYLEN });
  });

  it('verification reads parameters FROM the stored string, not from the current constants - an old hash with different params still verifies', async () => {
    // Deliberately SMALLER params than the current SCRYPT_N/R/P defaults, simulating a hash
    // written under a past, different configuration.
    const oldStyleHash = await hashPassword('legacy-password', { n: 4096, r: 4, p: 1, keylen: 32 });
    expect(parseHash(oldStyleHash)).toMatchObject({ n: 4096, r: 4, p: 1, keylen: 32 });
    expect(await verifyPasswordHash('legacy-password', oldStyleHash)).toBe(true);
  });

  it('verifyPasswordHash returns false (never throws) for a malformed/corrupted stored hash', async () => {
    expect(await verifyPasswordHash('anything', 'not-a-real-hash-string')).toBe(false);
  });

  it('two hashes of the SAME password are different strings (random salt per hash)', async () => {
    const a = await hashPassword('same-password');
    const b = await hashPassword('same-password');
    expect(a).not.toBe(b);
  });

  it('serializeHash/parseHash round-trip exactly', () => {
    const salt = Buffer.from('0123456789abcdef', 'utf8');
    const derivedKey = Buffer.from('fedcba9876543210fedcba9876543210', 'utf8');
    const str = serializeHash({ n: 16384, r: 8, p: 1, keylen: 33, salt, derivedKey });
    const parsed = parseHash(str);
    expect(parsed.n).toBe(16384);
    expect(parsed.salt.equals(salt)).toBe(true);
    expect(parsed.derivedKey.equals(derivedKey)).toBe(true);
  });

  it('getDummyHash is stable (the SAME string) across repeated calls in this process', async () => {
    const first = await getDummyHash();
    const second = await getDummyHash();
    expect(first).toBe(second);
  });

  it('verifyDummyHash never matches any password a real user would plausibly submit', async () => {
    expect(await verifyDummyHash('password123')).toBe(false);
    expect(await verifyDummyHash('')).toBe(false);
    expect(await verifyDummyHash('correct-horse-battery-staple')).toBe(false);
  });
});
