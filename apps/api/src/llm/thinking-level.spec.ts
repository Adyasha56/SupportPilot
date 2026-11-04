import { describe, expect, it } from 'vitest';
import { UnsupportedThinkingLevelError, validateThinkingLevel } from './thinking-level';

describe('validateThinkingLevel', () => {
  it('never throws when level is undefined, for any model', () => {
    expect(() => validateThinkingLevel('gemini-3.8-flash', undefined)).not.toThrow();
    expect(() => validateThinkingLevel('some-unknown-model', undefined)).not.toThrow();
  });

  it('throws UnsupportedThinkingLevelError for a real, documented incompatibility', () => {
    expect(() => validateThinkingLevel('gemini-3.8-flash', 'minimal')).toThrow(UnsupportedThinkingLevelError);
  });

  it('the thrown error names the model, the level, and the actually-supported set', () => {
    try {
      validateThinkingLevel('gemini-3.8-flash', 'minimal');
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(UnsupportedThinkingLevelError);
      const message = (err as Error).message;
      expect(message).toContain('gemini-3.8-flash');
      expect(message).toContain('minimal');
      expect(message).toContain('low');
      expect(message).toContain('medium');
      expect(message).toContain('high');
    }
  });

  it('allows a level that is actually supported by the model', () => {
    expect(() => validateThinkingLevel('gemini-3.8-flash', 'low')).not.toThrow();
    expect(() => validateThinkingLevel('gemini-3.8-flash', 'medium')).not.toThrow();
    expect(() => validateThinkingLevel('gemini-3.8-flash', 'high')).not.toThrow();
  });

  it('gemini-3.5-flash-lite supports minimal (the model this was first found against)', () => {
    expect(() => validateThinkingLevel('gemini-3.5-flash-lite', 'minimal')).not.toThrow();
  });

  it('never throws for a model not in the compatibility table - unknown, not assumed incompatible', () => {
    expect(() => validateThinkingLevel('some-future-model', 'minimal')).not.toThrow();
    expect(() => validateThinkingLevel('some-future-model', 'high')).not.toThrow();
  });
});
