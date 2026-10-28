import { describe, expect, it } from 'vitest';
import { loadLlmSettingsFromEnv } from './llm.settings';

describe('loadLlmSettingsFromEnv', () => {
  it('boots with sane defaults and no API key when nothing is set', () => {
    const settings = loadLlmSettingsFromEnv({});
    expect(settings.geminiApiKey).toBeUndefined();
    expect(settings.requestsPerMinute).toBeGreaterThan(0);
    expect(settings.maxConcurrency).toBeGreaterThan(0);
    expect(settings.maxTextsPerBatch).toBeGreaterThan(0);
    expect(settings.maxCharsPerText).toBeGreaterThan(0);
    expect(settings.cacheMaxEntries).toBeGreaterThan(0);
  });

  it('picks up every overridable value from env', () => {
    const settings = loadLlmSettingsFromEnv({
      GEMINI_API_KEY: 'sk_abc',
      GEMINI_EMBED_RPM: '20',
      GEMINI_EMBED_MAX_CONCURRENCY: '4',
      GEMINI_EMBED_MAX_RETRIES: '2',
      GEMINI_EMBED_TIMEOUT_MS: '3000',
      GEMINI_EMBED_MAX_BATCH: '10',
      GEMINI_EMBED_MAX_CHARS_PER_TEXT: '1000',
      GEMINI_EMBED_CACHE_MAX_ENTRIES: '50',
    });

    expect(settings).toEqual({
      geminiApiKey: 'sk_abc',
      requestsPerMinute: 20,
      maxConcurrency: 4,
      maxRetries: 2,
      requestTimeoutMs: 3000,
      maxTextsPerBatch: 10,
      maxCharsPerText: 1000,
      cacheMaxEntries: 50,
    });
  });

  it('throws a clear error on an invalid value rather than silently coercing it', () => {
    expect(() => loadLlmSettingsFromEnv({ GEMINI_EMBED_RPM: 'not-a-number' })).toThrow(/Invalid LlmSettings/);
  });
});
