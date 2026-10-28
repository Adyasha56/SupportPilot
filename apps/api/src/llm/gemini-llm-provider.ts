import { Inject, Injectable, Optional } from '@nestjs/common';
import { GoogleGenAI } from '@google/genai';
import { EMBEDDING_DIMENSION, EMBEDDING_MODEL } from '@supportpilot/shared';
import { EmbedError, EmbedErrorCode, EmbedOutcome, EmbeddingTaskType, EmbeddingVector, LlmProvider } from './llm-provider.interface';
import { LLM_SETTINGS } from './llm-settings.provider';
import { LlmSettings } from './llm.settings';
import { EmbeddingLruCache } from './embedding-cache';
import { GeminiEmbedClient, ThrottledClient, ThrottledClientError } from './throttled-gemini-client';

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
  private readonly client: ThrottledClient | undefined;
  private readonly cache: EmbeddingLruCache;

  /**
   * `testClient`, when provided, is used instead of constructing the real
   * SDK - the sole seam for injecting a fake in tests. It's @Optional()
   * because it has no injection token for Nest to resolve by type (the
   * interface is erased at runtime); production DI always resolves it to
   * undefined, and the real SDK client is built below.
   */
  constructor(
    @Inject(LLM_SETTINGS) private readonly settings: LlmSettings,
    @Optional() testClient?: GeminiEmbedClient,
  ) {
    this.cache = new EmbeddingLruCache(settings.cacheMaxEntries);

    if (!settings.geminiApiKey) {
      this.client = undefined;
      return;
    }

    const sdkClient = testClient ?? GeminiLlmProvider.buildSdkClient(settings.geminiApiKey);
    this.client = new ThrottledClient(sdkClient, settings);
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
      const response = await this.client!.embedContent({
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
}
