import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { GoogleGenAI, ThinkingLevel } from '@google/genai';
import { EMBEDDING_DIMENSION, EMBEDDING_MODEL } from '@supportpilot/shared';
import {
  EmbedError,
  EmbedErrorCode,
  EmbedOutcome,
  EmbeddingTaskType,
  EmbeddingVector,
  GenerateErrorCode,
  GenerateOptions,
  GenerateOutcome,
  LlmProvider,
} from './llm-provider.interface';
import { LLM_SETTINGS } from './llm-settings.provider';
import { LlmSettings } from './llm.settings';
import { EmbeddingLruCache } from './embedding-cache';
import { CircuitBreaker } from './circuit-breaker';
import {
  EmbedContentRequest,
  EmbedContentResult,
  GenerateContentRequest,
  GenerateContentResult,
  GeminiEmbedClient,
  GeminiGenerateClient,
  ThrottledClient,
  ThrottledClientError,
} from './throttled-gemini-client';

/** Only these two codes mean the upstream looked unavailable - see circuit-breaker.ts's own doc comment for why nothing else counts. */
function isAvailabilityFailureCode(code: GenerateErrorCode): boolean {
  return code === 'TIMEOUT' || code === 'UNAVAILABLE';
}

function error(code: EmbedErrorCode, message: string): EmbedOutcome {
  return { ok: false, error: { code, message } };
}

/**
 * Removes the configured API key from an error message before it's ever
 * returned, logged, or surfaced - defends against the SDK (or a future
 * version of it) echoing request details, such as a URL with the key as a
 * query parameter, back in an error message.
 */
function scrubSecret(message: string, secret: string | undefined): string {
  if (!secret) {
    return message;
  }
  return message.split(secret).join('[REDACTED]');
}

/** L2-normalizes in place conceptually (returns a new array) - gemini-embedding-001's docs state that only the full 3072-dimension output is pre-normalized; truncated outputs (768 here) must be normalized manually. */
function l2Normalize(values: number[]): number[] {
  const norm = Math.sqrt(values.reduce((sum, v) => sum + v * v, 0));
  if (norm === 0) {
    return values;
  }
  return values.map((v) => v / norm);
}

@Injectable()
export class GeminiLlmProvider implements LlmProvider {
  private readonly client: ThrottledClient<EmbedContentRequest, EmbedContentResult> | undefined;
  private readonly generateClient: ThrottledClient<GenerateContentRequest, GenerateContentResult> | undefined;
  private readonly cache: EmbeddingLruCache;
  private readonly circuitBreaker: CircuitBreaker;
  private readonly logger = new Logger(GeminiLlmProvider.name);

  /**
   * `testClient`/`testGenerateClient`, when provided, are used instead of
   * constructing the real SDK - the sole seam for injecting a fake in
   * tests. They're @Optional() because they have no injection token for
   * Nest to resolve by type (the interfaces are erased at runtime);
   * production DI always resolves them to undefined, and the real SDK
   * clients are built below. `testClock`, same reasoning, is the circuit
   * breaker's own injected-clock seam (Stage 4 finding 3) - production DI
   * always resolves it to undefined and the real wall clock is used.
   */
  constructor(
    @Inject(LLM_SETTINGS) private readonly settings: LlmSettings,
    @Optional() testClient?: GeminiEmbedClient,
    @Optional() testGenerateClient?: GeminiGenerateClient,
    @Optional() testClock?: () => Date,
  ) {
    this.cache = new EmbeddingLruCache(settings.cacheMaxEntries);
    this.circuitBreaker = new CircuitBreaker(
      { failureThreshold: settings.circuitBreakerFailureThreshold, cooldownMs: settings.circuitBreakerCooldownMs },
      testClock ?? (() => new Date()),
      (from, to) => this.logger.warn(`generate() circuit breaker ${from} -> ${to}`),
    );

    if (!settings.geminiApiKey) {
      this.client = undefined;
      this.generateClient = undefined;
      return;
    }

    const sdkClient = testClient ?? GeminiLlmProvider.buildSdkClient(settings.geminiApiKey);
    this.client = new ThrottledClient(sdkClient.embedContent.bind(sdkClient), {
      requestsPerMinute: settings.requestsPerMinute,
      maxConcurrency: settings.maxConcurrency,
      maxRetries: settings.maxRetries,
    });

    const sdkGenerateClient = testGenerateClient ?? GeminiLlmProvider.buildSdkGenerateClient(settings.geminiApiKey);
    this.generateClient = new ThrottledClient(sdkGenerateClient.generateContent.bind(sdkGenerateClient), {
      requestsPerMinute: settings.generateRequestsPerMinute,
      maxConcurrency: settings.generateMaxConcurrency,
      maxRetries: settings.generateMaxRetries,
    });
  }

  // Adapted explicitly to our own narrow interface rather than passing
  // `ai.models` directly - avoids depending on TypeScript's bivariant
  // method-param checking to make the SDK's wider EmbedContentParameters
  // assignable to our narrower EmbedContentRequest.
  private static buildSdkClient(apiKey: string): GeminiEmbedClient {
    const ai = new GoogleGenAI({ apiKey });
    return {
      embedContent: (request) =>
        ai.models.embedContent({
          model: request.model,
          contents: request.contents,
          config: {
            taskType: request.config.taskType,
            outputDimensionality: request.config.outputDimensionality,
            abortSignal: request.config.abortSignal,
          },
        }),
    };
  }

  /** Maps this project's plain lowercase level to the real SDK enum - confirmed against the installed @google/genai@2.31.0 SDK's own ThinkingLevel values (Stage 4 finding C). */
  private static toSdkThinkingLevel(level: 'minimal' | 'low' | 'medium' | 'high' | undefined): ThinkingLevel | undefined {
    switch (level) {
      case 'minimal':
        return ThinkingLevel.MINIMAL;
      case 'low':
        return ThinkingLevel.LOW;
      case 'medium':
        return ThinkingLevel.MEDIUM;
      case 'high':
        return ThinkingLevel.HIGH;
      default:
        return undefined;
    }
  }

  // Same adaptation reasoning as buildSdkClient above. systemInstruction
  // lives on GenerateContentConfig in the SDK (not as a separate top-level
  // parameter), and responseJsonSchema is passed exactly as given - this
  // provider never touches the SDK's own narrower `responseSchema` field.
  private static buildSdkGenerateClient(apiKey: string): GeminiGenerateClient {
    const ai = new GoogleGenAI({ apiKey });
    return {
      generateContent: async (request) => {
        const thinkingLevel = GeminiLlmProvider.toSdkThinkingLevel(request.config.thinkingLevel);
        const response = await ai.models.generateContent({
          model: request.model,
          contents: request.contents,
          config: {
            systemInstruction: request.systemInstruction,
            responseMimeType: request.config.responseMimeType,
            responseJsonSchema: request.config.responseJsonSchema,
            maxOutputTokens: request.config.maxOutputTokens,
            temperature: request.config.temperature,
            ...(thinkingLevel !== undefined ? { thinkingConfig: { thinkingLevel } } : {}),
            abortSignal: request.config.abortSignal,
          },
        });
        // finishReason lives on the first candidate, not at the top level -
        // mapped explicitly here (diagnostics only, see latency-probe.ts).
        return { text: response.text, usageMetadata: response.usageMetadata, finishReason: response.candidates?.[0]?.finishReason };
      },
    };
  }

  async embed(texts: string[], taskType: EmbeddingTaskType): Promise<EmbedOutcome> {
    if (!this.client) {
      return error('NOT_CONFIGURED', 'GEMINI_API_KEY is not set; embedding is unavailable.');
    }

    const validationError = this.validate(texts);
    if (validationError) {
      return validationError;
    }

    const vectors: EmbeddingVector[] = new Array(texts.length);
    const missingIndexes: number[] = [];
    const missingTexts: string[] = [];

    for (let i = 0; i < texts.length; i++) {
      const cacheKey = EmbeddingLruCache.key(EMBEDDING_MODEL, EMBEDDING_DIMENSION, taskType, texts[i]);
      const cached = this.cache.get(cacheKey);
      if (cached) {
        vectors[i] = { text: texts[i], values: cached };
      } else {
        missingIndexes.push(i);
        missingTexts.push(texts[i]);
      }
    }

    if (missingTexts.length > 0) {
      const fetched = await this.fetchEmbeddings(missingTexts, taskType);
      if (!fetched.ok) {
        return fetched;
      }
      for (let j = 0; j < missingIndexes.length; j++) {
        const index = missingIndexes[j];
        const values = fetched.vectors[j];
        vectors[index] = { text: texts[index], values };
        const cacheKey = EmbeddingLruCache.key(EMBEDDING_MODEL, EMBEDDING_DIMENSION, taskType, texts[index]);
        this.cache.set(cacheKey, values);
      }
    }

    return { ok: true, result: { vectors, model: EMBEDDING_MODEL, dimension: EMBEDDING_DIMENSION } };
  }

  private validate(texts: string[]): EmbedOutcome | undefined {
    if (texts.length === 0) {
      return error('INVALID_INPUT', 'At least one text is required.');
    }
    if (texts.length > this.settings.maxTextsPerBatch) {
      return error('INVALID_INPUT', `Too many texts in one batch: ${texts.length} > ${this.settings.maxTextsPerBatch}.`);
    }
    for (const text of texts) {
      if (text.length === 0) {
        return error('INVALID_INPUT', 'Empty strings cannot be embedded.');
      }
      if (text.length > this.settings.maxCharsPerText) {
        return error('INVALID_INPUT', `Text exceeds the ${this.settings.maxCharsPerText}-character limit.`);
      }
    }
    return undefined;
  }

  private async fetchEmbeddings(
    texts: string[],
    taskType: EmbeddingTaskType,
  ): Promise<{ ok: true; vectors: number[][] } | { ok: false; error: EmbedError }> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.settings.requestTimeoutMs);
    try {
      const response = await this.client!.call({
        model: EMBEDDING_MODEL,
        contents: texts,
        config: {
          taskType,
          outputDimensionality: EMBEDDING_DIMENSION,
          abortSignal: controller.signal,
        },
      });

      const embeddings = response.embeddings ?? [];
      if (embeddings.length !== texts.length) {
        return { ok: false, error: { code: 'TRANSIENT', message: `Expected ${texts.length} embedding(s) in the response, got ${embeddings.length}.` } };
      }

      return {
        ok: true,
        vectors: embeddings.map((embedding) => l2Normalize(embedding.values ?? [])),
      };
    } catch (err) {
      if (err instanceof ThrottledClientError) {
        return { ok: false, error: { code: err.code, message: scrubSecret(err.message, this.settings.geminiApiKey) } };
      }
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, error: { code: 'TRANSIENT', message: scrubSecret(message, this.settings.geminiApiKey) } };
    } finally {
      clearTimeout(timeout);
    }
  }

  async generate(options: GenerateOptions): Promise<GenerateOutcome> {
    if (!this.generateClient) {
      return { ok: false, error: { code: 'NOT_CONFIGURED', message: 'GEMINI_API_KEY is not set; generation is unavailable.' } };
    }
    if (options.messages.length === 0) {
      return { ok: false, error: { code: 'INVALID_INPUT', message: 'At least one message is required.' } };
    }

    // Stage 4 finding 3 - checked before any network call. 'reject' means
    // the breaker is open (or a half-open trial is already in flight) and
    // we return CIRCUIT_OPEN immediately without spending a real request.
    if (this.circuitBreaker.beforeCall() === 'reject') {
      return { ok: false, error: { code: 'CIRCUIT_OPEN', message: 'generate() is temporarily unavailable after repeated failures; try again shortly.' } };
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), options.timeoutMs);
    // Fires on EITHER this call's own per-call timeout OR the caller's
    // run-level deadline, whichever comes first - and, critically, is
    // passed to ThrottledClient.call() too (not just the SDK request's own
    // config.abortSignal), so it also cuts short any retry/backoff still
    // in progress, not just the single network call in flight at that
    // instant. See ThrottledClient's own doc comment for the bug this closes.
    const combinedSignal = options.abortSignal ? AbortSignal.any([controller.signal, options.abortSignal]) : controller.signal;
    try {
      const response = await this.generateClient.call(
        {
          model: this.settings.generateModel,
          systemInstruction: options.systemInstruction,
          contents: options.messages.map((message) => ({ role: message.role, parts: [{ text: message.text }] })),
          config: {
            responseMimeType: 'application/json',
            responseJsonSchema: options.responseSchema,
            maxOutputTokens: options.maxOutputTokens,
            temperature: options.temperature,
            thinkingLevel: options.thinkingLevel,
            abortSignal: combinedSignal,
          },
        },
        combinedSignal,
      );

      const text = response.text;
      if (text === undefined) {
        this.circuitBreaker.recordOutcome(false);
        return { ok: false, error: { code: 'INVALID_OUTPUT', message: 'Gemini returned no text in its response.' } };
      }
      try {
        // Only proves the text is SOME valid JSON value - the caller's own
        // Zod schema is what checks it's the RIGHT shape (see
        // GenerateErrorCode's INVALID_OUTPUT doc comment in
        // llm-provider.interface.ts); generate() has no access to that
        // schema, only to the raw JSON Schema object it was given.
        JSON.parse(text);
      } catch {
        this.circuitBreaker.recordOutcome(false);
        return { ok: false, error: { code: 'INVALID_OUTPUT', message: 'Gemini response text was not valid JSON.' } };
      }

      this.circuitBreaker.recordOutcome(false);
      return {
        ok: true,
        result: {
          text,
          usage: {
            inputTokens: response.usageMetadata?.promptTokenCount ?? 0,
            outputTokens: response.usageMetadata?.candidatesTokenCount ?? 0,
          },
          finishReason: response.finishReason,
        },
      };
    } catch (err) {
      if (err instanceof ThrottledClientError) {
        // ThrottledClient only ever reports 'ABORTED' generically - it has
        // no way to know which of the two signals combined into
        // combinedSignal actually fired. This is the one place that CAN
        // tell: if the caller's own run-level signal hasn't fired, the
        // abort must have come from THIS call's own per-call timeout
        // controller instead, which is a different, retryable failure
        // (TIMEOUT) - never the terminal, never-retried ABORTED.
        const code = err.code === 'ABORTED' && !options.abortSignal?.aborted ? 'TIMEOUT' : err.code;
        this.circuitBreaker.recordOutcome(isAvailabilityFailureCode(code));
        return { ok: false, error: { code, message: scrubSecret(err.message, this.settings.geminiApiKey), attempts: err.attempts } };
      }
      const message = err instanceof Error ? err.message : String(err);
      this.circuitBreaker.recordOutcome(false);
      return { ok: false, error: { code: 'TRANSIENT', message: scrubSecret(message, this.settings.geminiApiKey) } };
    } finally {
      clearTimeout(timeout);
    }
  }
}
