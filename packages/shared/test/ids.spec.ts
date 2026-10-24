import { describe, expect, it } from 'vitest';
import { idSchema } from '../src/ids';

describe('idSchema', () => {
  it('accepts letters, digits, dash and underscore up to 64 chars', () => {
    expect(idSchema().safeParse('cust_1').success).toBe(true);
    expect(idSchema().safeParse('ORD-1001').success).toBe(true);
    expect(idSchema().safeParse('a'.repeat(64)).success).toBe(true);
  });

  it('rejects strings over 64 chars or with unsafe characters', () => {
    expect(idSchema().safeParse('a'.repeat(65)).success).toBe(false);
    expect(idSchema().safeParse('../../etc/passwd').success).toBe(false);
    expect(idSchema().safeParse('has space').success).toBe(false);
  });

  it('applies a connector-supplied stricter pattern when given', () => {
    const acmeOrderId = idSchema('^ORD-\\d{4,}$');
    expect(acmeOrderId.safeParse('ORD-1001').success).toBe(true);
    expect(acmeOrderId.safeParse('cust_1').success).toBe(false);
  });

  it('applies the generic pattern IN ADDITION to a custom pattern, never instead of it', () => {
    // A permissive custom pattern that would accept anything, including a
    // string over the generic 64-char cap. The generic check must still reject it.
    const permissive = idSchema('.*');
    expect(permissive.safeParse('a'.repeat(100)).success).toBe(false);
    expect(permissive.safeParse('ORD-1001').success).toBe(true);
  });

  it('rejects a connector pattern string that exceeds the max pattern length', () => {
    const tooLong = '^(' + 'a'.repeat(201) + ')$';
    expect(() => idSchema(tooLong)).toThrow(/exceeds maximum length/);
  });
});
