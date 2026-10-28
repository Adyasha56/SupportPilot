import { describe, expect, it } from 'vitest';
import {
  generateRawApiKey,
  getKeyPrefix,
  hashApiKey,
  RAW_KEY_PREFIX,
  verifyApiKeyHash,
} from './api-key.service';

describe('generateRawApiKey', () => {
  it('starts with sk_ and is reasonably long/high-entropy', () => {
    const key = generateRawApiKey();
    expect(key.startsWith(RAW_KEY_PREFIX)).toBe(true);
    expect(key.length).toBeGreaterThan(40);
  });

  it('generates a different key every call', () => {
    const a = generateRawApiKey();
    const b = generateRawApiKey();
    expect(a).not.toBe(b);
  });
});

describe('hashApiKey / verifyApiKeyHash', () => {
  it('hashing the same raw key twice produces the same hash', () => {
    const key = generateRawApiKey();
    expect(hashApiKey(key)).toBe(hashApiKey(key));
  });

  it('verifies a correctly hashed key', () => {
    const key = generateRawApiKey();
    const hash = hashApiKey(key);
    expect(verifyApiKeyHash(hash, hash)).toBe(true);
  });

  it('rejects a mismatched hash', () => {
    const hashA = hashApiKey(generateRawApiKey());
    const hashB = hashApiKey(generateRawApiKey());
    expect(verifyApiKeyHash(hashA, hashB)).toBe(false);
  });

  it('rejects buffers of unequal length rather than throwing (defensive, not a realistic production case since SHA-256 is always 32 bytes)', () => {
    const normalHash = hashApiKey(generateRawApiKey());
    const shortInput = 'ab'; // 1 byte in hex, not 32
    expect(() => verifyApiKeyHash(shortInput, normalHash)).not.toThrow();
    expect(verifyApiKeyHash(shortInput, normalHash)).toBe(false);
  });
});

describe('getKeyPrefix', () => {
  it('returns the first 8 characters, for display only', () => {
    const key = generateRawApiKey();
    expect(getKeyPrefix(key)).toBe(key.slice(0, 8));
    expect(getKeyPrefix(key)).toHaveLength(8);
  });
});
