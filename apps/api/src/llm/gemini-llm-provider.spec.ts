import { describe, expect, it, vi } from 'vitest';
import { GeminiLlmProvider } from './gemini-llm-provider';
import { GenerateOptions } from './llm-provider.interface';
import { LlmSettings } from './llm.settings';
import { EmbedContentRequest, GeminiEmbedClient, GeminiGenerateClient, GenerateContentRequest, GenerateContentResult } from './throttled-gemini-client';

function makeGenerateOptions(overrides: Partial<GenerateOptions> = {}): GenerateOptions {
  return {
    systemInstruction: 'You are a fictional test fixture.',
    messages: [{ role: 'user', text: 'hello' }],
    responseSchema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] },
    maxOutputTokens: 100,
    temperature: 0,
    timeoutMs: 5000,
    ...overrides,
  };
}

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
    generateModel: 'gemini-3.5-flash-lite',
    generateRequestsPerMinute: 1000,
    generateMaxConcurrency: 1000,
    generateMaxRetries: 0,
    generateTimeoutMs: 5000,
    generateMaxOutputTokens: 1024,
    generateTemperature: 0,
    generateThinkingLevel: 'minimal',
    dailyGenerateBudget: 300,
    circuitBreakerFailureThreshold: 3,
    circuitBreakerCooldownMs: 60_000,
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
      embedContent: vi.fn(async (request: EmbedContentRequest) => {
        receivedRequests.push(request);
        // Mirrors the real SDK's documented contract: one ContentEmbedding
        // per input content, in the same order as the request's `contents`.
        // A one-hot vector per index so normalization can't collapse two
        // different inputs to the same direction (a plain scalar multiple,
        // e.g. [1,0,0] vs [2,0,0], would normalize to the same vector).
        return {
          embeddings: request.contents.map((_: string, i: number) => ({
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

  describe('generate', () => {
    it('returns NOT_CONFIGURED when no API key is set, and never touches any client', async () => {
      const provider = new GeminiLlmProvider(makeSettings({ geminiApiKey: undefined }));
      const result = await provider.generate(makeGenerateOptions());
      expect(result).toEqual({ ok: false, error: { code: 'NOT_CONFIGURED', message: expect.stringContaining('GEMINI_API_KEY') } });
    });

    it('rejects an empty messages array without touching the client', async () => {
      const generateContent = vi.fn();
      const provider = new GeminiLlmProvider(makeSettings(), undefined, { generateContent });
      const result = await provider.generate(makeGenerateOptions({ messages: [] }));
      expect(result).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
      expect(generateContent).not.toHaveBeenCalled();
    });

    it('sends systemInstruction, messages, and the response JSON schema through to the client, and returns usage', async () => {
      const receivedRequests: GenerateContentRequest[] = [];
      const fakeClient: GeminiGenerateClient = {
        generateContent: vi.fn(async (request) => {
          receivedRequests.push(request);
          return { text: '{"ok":true}', usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 3 } };
        }),
      };
      const provider = new GeminiLlmProvider(makeSettings(), undefined, fakeClient);

      const result = await provider.generate(
        makeGenerateOptions({
          systemInstruction: 'be fictional',
          messages: [
            { role: 'user', text: 'first' },
            { role: 'model', text: 'second' },
          ],
        }),
      );

      expect(receivedRequests).toHaveLength(1);
      expect(receivedRequests[0].systemInstruction).toBe('be fictional');
      expect(receivedRequests[0].contents).toEqual([
        { role: 'user', parts: [{ text: 'first' }] },
        { role: 'model', parts: [{ text: 'second' }] },
      ]);
      expect(receivedRequests[0].config.responseJsonSchema).toEqual(makeGenerateOptions().responseSchema);
      expect(receivedRequests[0].config.responseMimeType).toBe('application/json');

      expect(result).toEqual({ ok: true, result: { text: '{"ok":true}', usage: { inputTokens: 12, outputTokens: 3 } } });
    });

    it('forwards options.thinkingLevel through to the request, and omits it entirely when not set (Stage 4 finding C)', async () => {
      const receivedRequests: GenerateContentRequest[] = [];
      const fakeClient: GeminiGenerateClient = {
        generateContent: vi.fn(async (request) => {
          receivedRequests.push(request);
          return { text: '{}' };
        }),
      };
      const provider = new GeminiLlmProvider(makeSettings(), undefined, fakeClient);

      await provider.generate(makeGenerateOptions({ thinkingLevel: 'minimal' }));
      await provider.generate(makeGenerateOptions());

      expect(receivedRequests[0].config.thinkingLevel).toBe('minimal');
      expect(receivedRequests[1].config.thinkingLevel).toBeUndefined();
    });

    it('returns INVALID_OUTPUT when the response has no text at all', async () => {
      const fakeClient: GeminiGenerateClient = { generateContent: vi.fn(async () => ({})) };
      const provider = new GeminiLlmProvider(makeSettings(), undefined, fakeClient);

      const result = await provider.generate(makeGenerateOptions());

      expect(result).toMatchObject({ ok: false, error: { code: 'INVALID_OUTPUT' } });
    });

    it('returns INVALID_OUTPUT when the response text is not valid JSON, and never echoes the raw response text in the error', async () => {
      const secretLookingText = 'not json { "leakMarker": "sk_should_never_appear_in_error" }';
      const fakeClient: GeminiGenerateClient = { generateContent: vi.fn(async () => ({ text: secretLookingText })) };
      const provider = new GeminiLlmProvider(makeSettings(), undefined, fakeClient);

      const result = await provider.generate(makeGenerateOptions());

      expect(result).toMatchObject({ ok: false, error: { code: 'INVALID_OUTPUT' } });
      if (!result.ok) {
        expect(result.error.message).not.toContain(secretLookingText);
        expect(result.error.message).not.toContain('sk_should_never_appear_in_error');
      }
    });

    it('never echoes the prompt (systemInstruction or message text) in a thrown-error message', async () => {
      const fakeClient: GeminiGenerateClient = {
        generateContent: vi.fn(async () => {
          throw new Error('upstream failure');
        }),
      };
      const provider = new GeminiLlmProvider(makeSettings(), undefined, fakeClient);

      const result = await provider.generate(
        makeGenerateOptions({
          systemInstruction: 'SECRET_SYSTEM_MARKER',
          messages: [{ role: 'user', text: 'SECRET_MESSAGE_MARKER' }],
        }),
      );

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).not.toContain('SECRET_SYSTEM_MARKER');
        expect(result.error.message).not.toContain('SECRET_MESSAGE_MARKER');
      }
    });

    it('maps a thrown error to a typed GenerateError and never leaks the API key', async () => {
      const fakeClient: GeminiGenerateClient = {
        generateContent: vi.fn(async () => {
          throw Object.assign(new Error('request to https://x?key=sk_test_secret_12345 failed'), { status: 401 });
        }),
      };
      const provider = new GeminiLlmProvider(makeSettings(), undefined, fakeClient);

      const result = await provider.generate(makeGenerateOptions());

      expect(result).toMatchObject({ ok: false, error: { code: 'UNAUTHORIZED' } });
      if (!result.ok) {
        expect(result.error.message).not.toContain('sk_test_secret_12345');
        expect(result.error.message).toContain('[REDACTED]');
      }
    });

    describe('TIMEOUT vs ABORTED classification (Stage 4 finding B)', () => {
      /** A fake SDK client that never resolves on its own - the only way it ever settles is via the abort signal it's given, exactly like a real fetch-backed SDK call. */
      function hangingClient(): GeminiGenerateClient {
        return {
          generateContent: vi.fn(
            (request): Promise<GenerateContentResult> =>
              new Promise((_resolve, reject) => {
                request.config.abortSignal?.addEventListener(
                  'abort',
                  () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })),
                  { once: true },
                );
              }),
          ),
        };
      }

      it('classifies a per-call timeout (no external run-deadline signal involved) as TIMEOUT, never ABORTED', async () => {
        const provider = new GeminiLlmProvider(makeSettings(), undefined, hangingClient());

        const result = await provider.generate(makeGenerateOptions({ timeoutMs: 20 }));

        expect(result).toMatchObject({ ok: false, error: { code: 'TIMEOUT' } });
      });

      it('classifies the caller\'s own run-level abortSignal firing as ABORTED, never TIMEOUT - even with a much larger per-call timeout', async () => {
        const provider = new GeminiLlmProvider(makeSettings(), undefined, hangingClient());
        const controller = new AbortController();
        setTimeout(() => controller.abort(), 20);

        const result = await provider.generate(makeGenerateOptions({ timeoutMs: 60_000, abortSignal: controller.signal }));

        expect(result).toMatchObject({ ok: false, error: { code: 'ABORTED' } });
      });

      it('a call that succeeds well before either signal fires is unaffected by either', async () => {
        const fakeClient: GeminiGenerateClient = { generateContent: vi.fn(async () => ({ text: '{"ok":true}' })) };
        const provider = new GeminiLlmProvider(makeSettings(), undefined, fakeClient);
        const controller = new AbortController();

        const result = await provider.generate(makeGenerateOptions({ timeoutMs: 20_000, abortSignal: controller.signal }));

        expect(result.ok).toBe(true);
      });
    });

    it('uses its own throttle, independent of the embed client', async () => {
      const embedContent = vi.fn(async () => ({ embeddings: [{ values: [1] }] }));
      const generateContent = vi.fn(async () => ({ text: '{}' }));
      const provider = new GeminiLlmProvider(makeSettings(), { embedContent }, { generateContent });

      await provider.generate(makeGenerateOptions());
      await provider.embed(['text'], 'RETRIEVAL_DOCUMENT');

      expect(generateContent).toHaveBeenCalledTimes(1);
      expect(embedContent).toHaveBeenCalledTimes(1);
    });

    describe('circuit breaker (Stage 4 finding 3)', () => {
      function hangingClient(): GeminiGenerateClient {
        return {
          generateContent: vi.fn(
            (request): Promise<GenerateContentResult> =>
              new Promise((_resolve, reject) => {
                request.config.abortSignal?.addEventListener(
                  'abort',
                  () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })),
                  { once: true },
                );
              }),
          ),
        };
      }

      it('opens after K consecutive TIMEOUTs, then returns CIRCUIT_OPEN with zero further network calls', async () => {
        const client = hangingClient();
        const provider = new GeminiLlmProvider(makeSettings({ circuitBreakerFailureThreshold: 2 }), undefined, client, () => new Date(0));

        const first = await provider.generate(makeGenerateOptions({ timeoutMs: 10 }));
        expect(first).toMatchObject({ ok: false, error: { code: 'TIMEOUT' } });
        const second = await provider.generate(makeGenerateOptions({ timeoutMs: 10 }));
        expect(second).toMatchObject({ ok: false, error: { code: 'TIMEOUT' } });
        expect(client.generateContent).toHaveBeenCalledTimes(2);

        const third = await provider.generate(makeGenerateOptions({ timeoutMs: 10 }));
        expect(third).toMatchObject({ ok: false, error: { code: 'CIRCUIT_OPEN' } });
        // Still exactly 2 - the breaker rejected before any real network call.
        expect(client.generateContent).toHaveBeenCalledTimes(2);
      });

      /** A client whose behavior can be swapped between calls, without reaching into the provider's own internals - a plain delegate seam. */
      function switchableClient(initial: GeminiGenerateClient['generateContent']): { client: GeminiGenerateClient; setBehavior: (fn: GeminiGenerateClient['generateContent']) => void } {
        let behavior = initial;
        return {
          client: { generateContent: (request) => behavior(request) },
          setBehavior: (fn) => {
            behavior = fn;
          },
        };
      }

      it('a successful call resets the consecutive failure count, so the breaker never opens', async () => {
        const hanging = hangingClient();
        const { client, setBehavior } = switchableClient(hanging.generateContent);
        const generateContent = vi.fn(client.generateContent);
        const provider = new GeminiLlmProvider(makeSettings({ circuitBreakerFailureThreshold: 2 }), undefined, { generateContent }, () => new Date(0));

        // One TIMEOUT, then a real success, then one more TIMEOUT - never 2 consecutive, so it never opens.
        const first = await provider.generate(makeGenerateOptions({ timeoutMs: 10 }));
        expect(first).toMatchObject({ ok: false, error: { code: 'TIMEOUT' } });

        setBehavior(async () => ({ text: '{"ok":true}' }));
        const second = await provider.generate(makeGenerateOptions({ timeoutMs: 10 }));
        expect(second.ok).toBe(true);

        setBehavior(hanging.generateContent);
        const third = await provider.generate(makeGenerateOptions({ timeoutMs: 10 }));
        expect(third).toMatchObject({ ok: false, error: { code: 'TIMEOUT' } });
        expect(generateContent).toHaveBeenCalledTimes(3); // the breaker never rejected one of these outright
      });

      it('after the cooldown elapses, allows exactly one half-open trial; success closes the breaker again', async () => {
        let now = 0;
        const hanging = hangingClient();
        const { client, setBehavior } = switchableClient(hanging.generateContent);
        const generateContent = vi.fn(client.generateContent);
        const provider = new GeminiLlmProvider(
          makeSettings({ circuitBreakerFailureThreshold: 1, circuitBreakerCooldownMs: 1000 }),
          undefined,
          { generateContent },
          () => new Date(now),
        );

        const opening = await provider.generate(makeGenerateOptions({ timeoutMs: 10 }));
        expect(opening).toMatchObject({ ok: false, error: { code: 'TIMEOUT' } });

        const stillOpen = await provider.generate(makeGenerateOptions({ timeoutMs: 10 }));
        expect(stillOpen).toMatchObject({ ok: false, error: { code: 'CIRCUIT_OPEN' } });
        expect(generateContent).toHaveBeenCalledTimes(1); // the second call never reached the network

        now += 1000;
        setBehavior(async () => ({ text: '{"ok":true}' }));

        const trial = await provider.generate(makeGenerateOptions({ timeoutMs: 10 }));
        expect(trial.ok).toBe(true);

        const afterwards = await provider.generate(makeGenerateOptions({ timeoutMs: 10 }));
        expect(afterwards.ok).toBe(true);
        expect(generateContent).toHaveBeenCalledTimes(3); // trial + one more, both real calls now that it's closed
      });
    });
  });
});
