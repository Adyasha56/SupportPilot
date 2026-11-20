import { describe, expect, it } from 'vitest';
import { decodeMessageCursor, encodeMessageCursor } from './message-cursor';

describe('message-cursor', () => {
  it('round-trips createdAtMs and id', () => {
    const encoded = encodeMessageCursor({ createdAtMs: 1_700_000_000_000, id: '65f1a2b3c4d5e6f7a8b9c0d1' });
    const decoded = decodeMessageCursor(encoded);
    expect(decoded).toEqual({ createdAtMs: 1_700_000_000_000, id: '65f1a2b3c4d5e6f7a8b9c0d1' });
  });

  it('decodes undefined for a missing cursor', () => {
    expect(decodeMessageCursor(undefined)).toBeUndefined();
  });

  it('decodes undefined for an empty string', () => {
    expect(decodeMessageCursor('')).toBeUndefined();
  });

  it('decodes undefined (never throws) for garbage base64url', () => {
    expect(decodeMessageCursor('not-a-real-cursor-!!!')).toBeUndefined();
  });

  it('decodes undefined for a well-formed-base64 string with no separator', () => {
    const noSeparator = Buffer.from('just-some-text-no-colon', 'utf8').toString('base64url');
    expect(decodeMessageCursor(noSeparator)).toBeUndefined();
  });

  it('decodes undefined when the timestamp half is not a finite number', () => {
    const malformed = Buffer.from('not-a-number:someid', 'utf8').toString('base64url');
    expect(decodeMessageCursor(malformed)).toBeUndefined();
  });

  it('decodes undefined when the id half is empty', () => {
    const malformed = Buffer.from('12345:', 'utf8').toString('base64url');
    expect(decodeMessageCursor(malformed)).toBeUndefined();
  });
});
