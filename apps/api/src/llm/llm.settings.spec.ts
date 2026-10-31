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
    expect(settings.generateModel.length).toBeGreaterThan(0);
    expect(settings.generateRequestsPerMinute).toBeGreaterThan(0);
    expect(settings.generateMaxConcurrency).toBeGreaterThan(0);
    expect(settings.generateTimeoutMs).toBeGreaterThan(0);
    expect(settings.generateMaxOutputTokens).toBeGreaterThan(0);
  });

  it('picks up every overridable embed value from env', () => {
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

    expect(settings).toMatchObject({
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

  it('picks up every overridable generate value from env, independent of the embed settings', () => {
    const settings = loadLlmSettingsFromEnv({
      GEMINI_API_KEY: 'sk_abc',
      GEMINI_GENERATE_MODEL: 'gemini-3.8-flash',
      GEMINI_GENERATE_RPM: '15',
      GEMINI_GENERATE_MAX_CONCURRENCY: '3',
      GEMINI_GENERATE_MAX_RETRIES: '1',
      GEMINI_GENERATE_TIMEOUT_MS: '25000',
      GEMINI_GENERATE_MAX_OUTPUT_TOKENS: '2048',
      GEMINI_GENERATE_TEMPERATURE: '0.5',
    });

    expect(settings).toMatchObject({
      generateModel: 'gemini-3.8-flash',
      generateRequestsPerMinute: 15,
      generateMaxConcurrency: 3,
      generateMaxRetries: 1,
      generateTimeoutMs: 25000,
      generateMaxOutputTokens: 2048,
      generateTemperature: 0.5,
    });
    // Untouched embed settings keep their own independent defaults.
    expect(settings.requestsPerMinute).toBe(10);
  });

  it('defaults GEMINI_GENERATE_MODEL to the recommended free-tier model when unset', () => {
    const settings = loadLlmSettingsFromEnv({});
    expect(settings.generateModel).toBe('gemini-3.5-flash-lite');
  });

  it('throws a clear error on an invalid embed value rather than silently coercing it', () => {
    expect(() => loadLlmSettingsFromEnv({ GEMINI_EMBED_RPM: 'not-a-number' })).toThrow(/Invalid LlmSettings/);
  });

  it('throws a clear error on an invalid generate value rather than silently coercing it', () => {
    expect(() => loadLlmSettingsFromEnv({ GEMINI_GENERATE_RPM: 'not-a-number' })).toThrow(/Invalid LlmSettings/);
  });
});
