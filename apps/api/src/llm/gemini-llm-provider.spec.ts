import { describe, expect, it, vi } from 'vitest';
import { GeminiLlmProvider } from './gemini-llm-provider';
import { LlmSettings } from './llm.settings';
import { EmbedContentRequest, GeminiEmbedClient } from './throttled-gemini-client';

function makeSettings(overrides: Partial<LlmSettings> = {}): LlmSettings {
  return {
    geminiApiKey: 'sk_test_secret_12345',
    requestsPerMinute: 1000,
    maxConcurrency: 1000,
    maxRetries: 0,
    requestTimeoutMs: 5000,
    maxTextsPerBatch: 32,
    maxCharsPerText: 8000,
    cacheMaxEntries: 500,
    ...overrides,
  };
}

describe('GeminiLlmProvider', () => {
  it('returns NOT_CONFIGURED when no API key is set, and never touches any client', async () => {
    const provider = new GeminiLlmProvider(makeSettings({ geminiApiKey: undefined }));
    const result = await provider.embed(['hello'], 'RETRIEVAL_DOCUMENT');
    expect(result).toEqual({ ok: false, error: { code: 'NOT_CONFIGURED', message: expect.stringContaining('GEMINI_API_KEY') } });
  });

  describe('input validation', () => {
    it('rejects an empty batch', async () => {
      const provider = new GeminiLlmProvider(makeSettings(), { embedContent: vi.fn() });
      const result = await provider.embed([], 'RETRIEVAL_DOCUMENT');
      expect(result).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    });

    it('rejects a batch larger than maxTextsPerBatch', async () => {
      const provider = new GeminiLlmProvider(makeSettings({ maxTextsPerBatch: 2 }), { embedContent: vi.fn() });
      const result = await provider.embed(['a', 'b', 'c'], 'RETRIEVAL_DOCUMENT');
      expect(result).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    });

    it('rejects an empty string', async () => {
      const provider = new GeminiLlmProvider(makeSettings(), { embedContent: vi.fn() });
      const result = await provider.embed([''], 'RETRIEVAL_DOCUMENT');
      expect(result).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    });

    it('rejects a text longer than maxCharsPerText', async () => {
      const provider = new GeminiLlmProvider(makeSettings({ maxCharsPerText: 5 }), { embedContent: vi.fn() });
      const result = await provider.embed(['123456'], 'RETRIEVAL_DOCUMENT');
      expect(result).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    });
  });

  it('sends every text as one batch request and maps each embedding back to its input, in order', async () => {
    const receivedRequests: EmbedContentRequest[] = [];
    const fakeClient: GeminiEmbedClient = {
      embedContent: vi.fn(async (request) => {
        receivedRequests.push(request);
        // Mirrors the real SDK's documented contract: one ContentEmbedding
        // per input content, in the same order as the request's `contents`.
        // A one-hot vector per index so normalization can't collapse two
        // different inputs to the same direction (a plain scalar multiple,
        // e.g. [1,0,0] vs [2,0,0], would normalize to the same vector).
        return {
          embeddings: request.contents.map((_, i) => ({
            values: [0, 1, 2].map((position) => (position === i ? 1 : 0)),
          })),
        };
      }),
    };
    const provider = new GeminiLlmProvider(makeSettings(), fakeClient);

    const result = await provider.embed(['first', 'second', 'third'], 'RETRIEVAL_DOCUMENT');

    expect(receivedRequests).toHaveLength(1); // one batch call, not one per text
    expect(receivedRequests[0].contents).toEqual(['first', 'second', 'third']);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.result.vectors.map((v) => v.text)).toEqual(['first', 'second', 'third']);
      expect(result.result.vectors[0].values[0]).toBeCloseTo(1);
      expect(result.result.vectors[1].values[0]).toBeCloseTo(0);
      expect(result.result.vectors[2].values[0]).toBeCloseTo(0);
    }
  });

  it('L2-normalizes vectors that come back non-normalized', async () => {
    const fakeClient: GeminiEmbedClient = {
      embedContent: vi.fn(async () => ({ embeddings: [{ values: [3, 4, 0] }] })), // norm = 5
    };
    const provider = new GeminiLlmProvider(makeSettings(), fakeClient);

    const result = await provider.embed(['text'], 'RETRIEVAL_QUERY');

    expect(result.ok).toBe(true);
    if (result.ok) {
      const [x, y, z] = result.result.vectors[0].values;
      expect(x).toBeCloseTo(0.6);
      expect(y).toBeCloseTo(0.8);
      expect(z).toBeCloseTo(0);
      const norm = Math.sqrt(x * x + y * y + z * z);
      expect(norm).toBeCloseTo(1);
    }
  });

  it('caches by model+dimension+taskType+text, so a repeated call never hits the client again', async () => {
    const embedContent = vi.fn(async () => ({ embeddings: [{ values: [1, 0] }] }));
    const provider = new GeminiLlmProvider(makeSettings(), { embedContent });

    await provider.embed(['same text'], 'RETRIEVAL_DOCUMENT');
    await provider.embed(['same text'], 'RETRIEVAL_DOCUMENT');

    expect(embedContent).toHaveBeenCalledTimes(1);
  });

  it('does not reuse a cached vector across different task types for the same text', async () => {
    const embedContent = vi.fn(async () => ({ embeddings: [{ values: [1, 0] }] }));
    const provider = new GeminiLlmProvider(makeSettings(), { embedContent });

    await provider.embed(['same text'], 'RETRIEVAL_DOCUMENT');
    await provider.embed(['same text'], 'RETRIEVAL_QUERY');

    expect(embedContent).toHaveBeenCalledTimes(2);
  });

  it('maps a thrown error to a typed EmbedError and never leaks the API key', async () => {
    const fakeClient: GeminiEmbedClient = {
      embedContent: vi.fn(async () => {
        throw Object.assign(new Error('request to https://x?key=sk_test_secret_12345 failed'), { status: 401 });
      }),
    };
    const provider = new GeminiLlmProvider(makeSettings(), fakeClient);

    const result = await provider.embed(['text'], 'RETRIEVAL_DOCUMENT');

    expect(result).toMatchObject({ ok: false, error: { code: 'UNAUTHORIZED' } });
    if (!result.ok) {
      expect(result.error.message).not.toContain('sk_test_secret_12345');
      expect(result.error.message).toContain('[REDACTED]');
    }
  });

  it('returns a TRANSIENT error if the response has a different number of embeddings than inputs', async () => {
    const fakeClient: GeminiEmbedClient = {
      embedContent: vi.fn(async () => ({ embeddings: [{ values: [1] }] })), // only 1, for 2 inputs
    };
    const provider = new GeminiLlmProvider(makeSettings(), fakeClient);

    const result = await provider.embed(['a', 'b'], 'RETRIEVAL_DOCUMENT');

    expect(result).toMatchObject({ ok: false, error: { code: 'TRANSIENT' } });
  });
});
