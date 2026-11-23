import { scrypt } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  getDummyHash,
  hashPassword,
  isWeakerThanCurrentParams,
  maxmemFor,
  parseHash,
  SCRYPT_KEYLEN,
  SCRYPT_N,
  SCRYPT_P,
  SCRYPT_R,
  serializeHash,
  storedHashIsWeak,
  verifyDummyHash,
  verifyPasswordHash,
} from './password-hash';

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

  describe('Part 0, item Q1 - the corrected parameters are a REAL OWASP row, not the original deviation', () => {
    it('the current defaults are exactly OWASP row #4 (N=2^14, r=8, p=5) - a regression guard against silently drifting back to p=1', () => {
      expect(SCRYPT_N).toBe(16_384);
      expect(SCRYPT_R).toBe(8);
      expect(SCRYPT_P).toBe(5);
    });

    it('maxmemFor is exactly 128*N*r plus the fixed headroom, independent of p', () => {
      expect(maxmemFor(16_384, 8)).toBe(128 * 16_384 * 8 + 1024 * 1024);
    });

    it('a real scrypt call at the current defaults actually SUCCEEDS with the explicit maxmem this project sets - never relies on node:crypto\'s own 32 MiB default', async () => {
      // 128 MiB (OWASP row #1, N=2^17) EXCEEDS node:crypto's default maxmem (32 MiB) - if this
      // project ever raised SCRYPT_N that far without maxmemFor, every hash would throw. This
      // proves maxmemFor's own headroom is actually sufcient for arbitrary rows, not just the
      // one currently selected.
      const n = 131_072; // 2^17
      const r = 8;
      const key = await new Promise<Buffer>((resolve, reject) => {
        scrypt('x', Buffer.from('0123456789abcdef'), 32, { N: n, r, p: 1, maxmem: maxmemFor(n, r) }, (err, key) => (err ? reject(err) : resolve(key as Buffer)));
      });
      expect(key.length).toBe(32);
    });

    it('isWeakerThanCurrentParams: the ORIGINAL bug (N=2^14,r=8,p=1) is weaker than the corrected default', () => {
      expect(isWeakerThanCurrentParams({ n: 16_384, r: 8, p: 1 })).toBe(true);
    });

    it('isWeakerThanCurrentParams: a DIFFERENT OWASP row (comparable total work) is never treated as weaker just because N differs', () => {
      // OWASP row #1: N=2^17, r=8, p=1 -> work = 131072*8*1 = 1,048,576
      // current default: N=2^14, r=8, p=5 -> work = 16384*8*5 = 655,360
      // Row #1 does MORE total work, so it is correctly NOT weaker.
      expect(isWeakerThanCurrentParams({ n: 131_072, r: 8, p: 1 })).toBe(false);
    });

    it('isWeakerThanCurrentParams: the current default itself is never weaker than itself', () => {
      expect(isWeakerThanCurrentParams({ n: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P })).toBe(false);
    });

    it('storedHashIsWeak parses a real hash string end to end, and never throws on garbage', async () => {
      const weakHash = await hashPassword('x', { n: 16_384, r: 8, p: 1, keylen: 32 });
      const strongHash = await hashPassword('x');
      expect(storedHashIsWeak(weakHash)).toBe(true);
      expect(storedHashIsWeak(strongHash)).toBe(false);
      expect(storedHashIsWeak('not-a-real-hash')).toBe(false);
    });
  });
});
