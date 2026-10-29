import { describe, expect, it } from 'vitest';
import { loadRetrievalSettingsFromEnv } from './retrieval.settings';

describe('loadRetrievalSettingsFromEnv', () => {
  it('boots with sane defaults when nothing is set', () => {
    const settings = loadRetrievalSettingsFromEnv({});
    expect(settings.maxQueryLength).toBeGreaterThan(0);
    expect(settings.defaultTopK).toBe(5);
    expect(settings.maxTopK).toBe(10);
  });

  it('picks up every overridable value from env', () => {
    const settings = loadRetrievalSettingsFromEnv({
      RETRIEVAL_MAX_QUERY_LENGTH: '500',
      RETRIEVAL_DEFAULT_TOP_K: '3',
      RETRIEVAL_MAX_TOP_K: '8',
    });
    expect(settings).toEqual({ maxQueryLength: 500, defaultTopK: 3, maxTopK: 8 });
  });

  it('throws a clear error on an invalid value rather than silently coercing it', () => {
    expect(() => loadRetrievalSettingsFromEnv({ RETRIEVAL_MAX_QUERY_LENGTH: 'not-a-number' })).toThrow(/Invalid RetrievalSettings/);
  });
});
