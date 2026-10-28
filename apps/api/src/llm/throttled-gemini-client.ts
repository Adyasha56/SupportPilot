import { EmbedErrorCode } from './llm-provider.interface';
import { LlmSettings } from './llm.settings';

/**
 * The minimal surface this file needs from @google/genai's `ai.models`,
 * expressed as our own interface (not the SDK's types) so tests can inject
 * a plain fake with none of the SDK's machinery. GeminiLlmProvider adapts
 * the real SDK object to this shape explicitly - see its constructor.
 */
export interface EmbedContentRequest {
  model: string;
  contents: string[];
  config: {
    taskType: string;
    outputDimensionality: number;
    abortSignal?: AbortSignal;
  };
}

export interface EmbedContentResult {
  embeddings?: Array<{ values?: number[] }>;
}

export interface GeminiEmbedClient {
  embedContent(request: EmbedContentRequest): Promise<EmbedContentResult>;
}

export class ThrottledClientError extends Error {
  constructor(
    public readonly code: EmbedErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ThrottledClientError';
  }
}

/**
 * An error thrown by the underlying client that carries an HTTP-like
 * status. @google/genai's own ApiError has exactly this shape (a `status`
 * number); this interface exists so classification doesn't depend on the
 * SDK's class directly, and so fakes in tests can throw plain objects.
 */
interface StatusError {
  status?: number;
}

function hasStatus(err: unknown): err is StatusError {
  return typeof err === 'object' && err !== null && 'status' in err;
}

function classifyError(err: unknown): { code: EmbedErrorCode; retryable: boolean } {
  const status = hasStatus(err) ? err.status : undefined;
  if (status === 429) {
    return { code: 'RATE_LIMITED', retryable: true };
  }
  if (status === 401 || status === 403) {
    return { code: 'UNAUTHORIZED', retryable: false };
  }
  if (status === 400 || status === 404) {
    return { code: 'INVALID_INPUT', retryable: false };
  }
  if (typeof status === 'number' && status >= 500) {
    return { code: 'UNAVAILABLE', retryable: true };
  }
  // No status at all (network error, our own abort/timeout, anything
  // unrecognized) - treated as transient and retryable, never as a reason
  // to give up immediately.
  return { code: 'TRANSIENT', retryable: true };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const BASE_DELAY_MS = 500;
const MAX_DELAY_MS = 30_000;

/**
 * Full jitter: a uniformly random delay between 0 and the exponential cap,
 * not the capped value itself - spreads retries out instead of having many
 * callers retry in lockstep after the same backoff.
 */
function backoffDelayMs(attempt: number): number {
  const cap = Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** attempt);
  return Math.random() * cap;
}

/**
 * Wraps a GeminiEmbedClient with: a requests-per-minute limiter (sliding
 * 60s window), bounded concurrency, and exponential backoff with jitter on
 * 429/5xx only (never on 400/401/403 - those are never going to succeed on
 * retry). Tests drive this with vi.useFakeTimers() - sleep() above is a
 * plain setTimeout, so no real waiting happens in test runs.
 */
export class ThrottledClient implements GeminiEmbedClient {
  private readonly recentCallTimestamps: number[] = [];
  private activeCount = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(
    private readonly inner: GeminiEmbedClient,
    private readonly settings: Pick<LlmSettings, 'requestsPerMinute' | 'maxConcurrency' | 'maxRetries'>,
  ) {}

  async embedContent(request: EmbedContentRequest): Promise<EmbedContentResult> {
    const release = await this.acquireConcurrencySlot();
    try {
      return await this.embedContentWithRetry(request);
    } finally {
      release();
    }
  }

  private async embedContentWithRetry(request: EmbedContentRequest): Promise<EmbedContentResult> {
    let lastCode: EmbedErrorCode = 'TRANSIENT';
    for (let attempt = 0; attempt <= this.settings.maxRetries; attempt++) {
      await this.waitForRateLimitSlot();
      try {
        return await this.inner.embedContent(request);
      } catch (err) {
        const { code, retryable } = classifyError(err);
        if (!retryable) {
          throw new ThrottledClientError(code, err instanceof Error ? err.message : String(err));
        }
        lastCode = code;
        if (attempt === this.settings.maxRetries) {
          break;
        }
        await sleep(backoffDelayMs(attempt));
      }
    }
    throw new ThrottledClientError(lastCode, `Gave up after ${this.settings.maxRetries + 1} attempt(s), last error was ${lastCode}.`);
  }

  private async waitForRateLimitSlot(): Promise<void> {
    const windowMs = 60_000;
    for (;;) {
      const now = Date.now();
      while (this.recentCallTimestamps.length > 0 && now - this.recentCallTimestamps[0] >= windowMs) {
        this.recentCallTimestamps.shift();
      }
      if (this.recentCallTimestamps.length < this.settings.requestsPerMinute) {
        this.recentCallTimestamps.push(now);
        return;
      }
      const waitMs = windowMs - (now - this.recentCallTimestamps[0]);
      await sleep(Math.max(waitMs, 0));
    }
  }

  private acquireConcurrencySlot(): Promise<() => void> {
    const release = (): void => {
      this.activeCount--;
      const next = this.waiters.shift();
      if (next) {
        next();
      }
    };

    if (this.activeCount < this.settings.maxConcurrency) {
      this.activeCount++;
      return Promise.resolve(release);
    }

    return new Promise((resolve) => {
      this.waiters.push(() => {
        this.activeCount++;
        resolve(release);
      });
    });
  }
}
