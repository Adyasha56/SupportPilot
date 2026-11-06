import { describe, expect, it } from 'vitest';
import { generateRunId } from './run-id';

describe('generateRunId', () => {
  it('is prefixed with r_ and never repeats across many calls', () => {
    const ids = new Set(Array.from({ length: 1000 }, () => generateRunId()));
    expect(ids.size).toBe(1000);
    for (const id of ids) {
      expect(id.startsWith('r_')).toBe(true);
    }
  });
});
