import { describe, expect, it } from 'vitest';
import { containsNulByte, decodeStrictUtf8, hasAllowedExtension, sanitizeTitle } from './upload-validation';

describe('hasAllowedExtension', () => {
  it('accepts .md and .txt, case-insensitively', () => {
    expect(hasAllowedExtension('policy.md')).toBe(true);
    expect(hasAllowedExtension('policy.TXT')).toBe(true);
    expect(hasAllowedExtension('Policy.Md')).toBe(true);
  });

  it('rejects anything else, regardless of what the client claims the type is', () => {
    expect(hasAllowedExtension('policy.pdf')).toBe(false);
    expect(hasAllowedExtension('policy.exe')).toBe(false);
    expect(hasAllowedExtension('policy')).toBe(false);
    expect(hasAllowedExtension('policy.md.exe')).toBe(false);
  });
});

describe('decodeStrictUtf8', () => {
  it('decodes valid UTF-8, including multi-byte characters', () => {
    expect(decodeStrictUtf8(Buffer.from('héllo 😀', 'utf8'))).toBe('héllo 😀');
  });

  it('rejects invalid UTF-8 byte sequences rather than substituting U+FFFD', () => {
    const invalid = Buffer.from([0xff, 0xfe, 0x00, 0x41]); // not valid UTF-8
    expect(decodeStrictUtf8(invalid)).toBeNull();
  });

  it('rejects a lone continuation byte', () => {
    const invalid = Buffer.from([0x80]);
    expect(decodeStrictUtf8(invalid)).toBeNull();
  });
});

describe('containsNulByte', () => {
  it('detects an embedded NUL byte', () => {
    expect(containsNulByte('before\u0000after')).toBe(true);
  });

  it('is false for normal text', () => {
    expect(containsNulByte('normal text')).toBe(false);
  });
});

describe('sanitizeTitle', () => {
  it('trims and passes through a normal title', () => {
    expect(sanitizeTitle('  Refund Policy  ', 200)).toBe('Refund Policy');
  });

  it('strips control characters including NUL', () => {
    expect(sanitizeTitle('Ref\u0000und\u0007 Policy', 200)).toBe('Refund Policy');
  });

  it('caps length', () => {
    expect(sanitizeTitle('x'.repeat(300), 10)).toBe('x'.repeat(10));
  });

  it('falls back to a default when empty, undefined, or whitespace/control-only', () => {
    expect(sanitizeTitle(undefined, 200)).toBe('Untitled policy');
    expect(sanitizeTitle('', 200)).toBe('Untitled policy');
    expect(sanitizeTitle('   \u0000\u0007  ', 200)).toBe('Untitled policy');
  });
});
