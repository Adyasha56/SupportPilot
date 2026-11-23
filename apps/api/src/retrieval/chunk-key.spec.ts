import { describe, expect, it } from 'vitest';
import { buildChunkKey, parseChunkKey } from './chunk-key';

describe('buildChunkKey / parseChunkKey', () => {
  it('round-trips a UUID documentId (which itself contains hyphens) and a position', () => {
    const documentId = '66b38f47-f4ff-45c3-ba01-8e177c0b3682';
    const key = buildChunkKey(documentId, 3);
    expect(key).toBe(`${documentId}-3`);
    expect(parseChunkKey(key)).toEqual({ documentId, position: 3 });
  });

  it('round-trips position 0', () => {
    const key = buildChunkKey('doc-1', 0);
    expect(parseChunkKey(key)).toEqual({ documentId: 'doc-1', position: 0 });
  });

  it('returns undefined for a key with no hyphen at all', () => {
    expect(parseChunkKey('nodashhere')).toBeUndefined();
  });

  it('returns undefined when the suffix after the last hyphen is not a plain integer', () => {
    expect(parseChunkKey('doc-1-abc')).toBeUndefined();
    expect(parseChunkKey('doc--')).toBeUndefined();
  });

  it('returns undefined for an empty string', () => {
    expect(parseChunkKey('')).toBeUndefined();
  });
});
