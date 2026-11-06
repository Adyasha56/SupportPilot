import { describe, expect, it } from 'vitest';
import { GENERIC_ID_PATTERN } from '@supportpilot/shared';
import { generateConversationId } from './conversation-id';

describe('generateConversationId', () => {
  it('produces a 22-character base64url string with no padding', () => {
    const id = generateConversationId();
    expect(id).toHaveLength(22);
    expect(id).not.toContain('=');
  });

  it('matches the shared generic id pattern used everywhere else', () => {
    const id = generateConversationId();
    expect(GENERIC_ID_PATTERN.test(id)).toBe(true);
  });

  it('is never sequential or predictable - 500 calls produce 500 distinct ids', () => {
    const ids = new Set<string>();
    for (let i = 0; i < 500; i++) {
      ids.add(generateConversationId());
    }
    expect(ids.size).toBe(500);
  });
});
