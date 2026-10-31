import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EmbedContentRequest, EmbedContentResult, ThrottledClient, ThrottledClientError } from './throttled-gemini-client';

const request: EmbedContentRequest = {
  model: 'gemini-embedding-001',
  contents: ['hello'],
  config: { taskType: 'RETRIEVAL_DOCUMENT', outputDimensionality: 768 },
};

function makeSettings(overrides: Partial<{ requestsPerMinute: number; maxConcurrency: number; maxRetries: number }> = {}) {
  return { requestsPerMinute: 1000, maxConcurrency: 1000, maxRetries: 3, ...overrides };
}

function statusError(status: number): Error & { status: number } {
  return Object.assign(new Error(`status ${status}`), { status });
}

describe('ThrottledClient', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns the inner result on the first attempt, with no retry', async () => {
    const innerCall = vi.fn(async (): Promise<EmbedContentResult> => ({ embeddings: [{ values: [1] }] }));
    const client = new ThrottledClient(innerCall, makeSettings());

    const result = await client.call(request);

    expect(result.embeddings).toEqual([{ values: [1] }]);
    expect(innerCall).toHaveBeenCalledTimes(1);
  });

  it('retries on 429 with backoff, then succeeds', async () => {
    let calls = 0;
    const innerCall = vi.fn(async (): Promise<EmbedContentResult> => {
      calls++;
      if (calls < 3) {
        throw statusError(429);
      }
      return { embeddings: [{ values: [1] }] };
    });
    const client = new ThrottledClient(innerCall, makeSettings());

    const resultPromise = client.call(request);
    // Two backoff sleeps happen before the third, successful attempt - the
    // exponential cap at attempt 0/1 is well under 30s, so this is enough.
    await vi.advanceTimersByTimeAsync(60_000);
    const result = await resultPromise;

    expect(result.embeddings).toEqual([{ values: [1] }]);
    expect(innerCall).toHaveBeenCalledTimes(3);
  });

  it('retries on a 5xx error', async () => {
    let calls = 0;
    const innerCall = vi.fn(async (): Promise<EmbedContentResult> => {
      calls++;
      if (calls < 2) {
        throw statusError(503);
      }
      return { embeddings: [{ values: [1] }] };
    });
    const client = new ThrottledClient(innerCall, makeSettings());

    const resultPromise = client.call(request);
    await vi.advanceTimersByTimeAsync(60_000);
    await resultPromise;

    expect(innerCall).toHaveBeenCalledTimes(2);
  });

  it('never retries a 401 - fails immediately as UNAUTHORIZED', async () => {
    const innerCall = vi.fn(async (): Promise<EmbedContentResult> => {
      throw statusError(401);
    });
    const client = new ThrottledClient(innerCall, makeSettings());

    await expect(client.call(request)).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    expect(innerCall).toHaveBeenCalledTimes(1);
  });

  it('never retries a 400 - fails immediately as INVALID_INPUT', async () => {
    const innerCall = vi.fn(async (): Promise<EmbedContentResult> => {
      throw statusError(400);
    });
    const client = new ThrottledClient(innerCall, makeSettings());

    await expect(client.call(request)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(innerCall).toHaveBeenCalledTimes(1);
  });

  it('gives up after maxRetries and throws a typed error carrying the last classified code', async () => {
    const innerCall = vi.fn(async (): Promise<EmbedContentResult> => {
      throw statusError(429);
    });
    const client = new ThrottledClient(innerCall, makeSettings({ maxRetries: 2 }));

    const resultPromise = client.call(request);
    let caught: unknown;
    resultPromise.catch((err) => {
      caught = err;
    });
    await vi.advanceTimersByTimeAsync(120_000);
    await vi.waitFor(() => expect(caught).toBeInstanceOf(ThrottledClientError));

    expect((caught as ThrottledClientError).code).toBe('RATE_LIMITED');
    expect(innerCall).toHaveBeenCalledTimes(3); // initial + 2 retries
  });

  it('bounds concurrency: a second call does not start until a slot frees up', async () => {
    const order: string[] = [];
    let resolveFirst: (() => void) | undefined;
    const innerCall = vi.fn(async (req: EmbedContentRequest): Promise<EmbedContentResult> => {
      order.push(`start:${req.contents[0]}`);
      if (req.contents[0] === 'first') {
        await new Promise<void>((resolve) => {
          resolveFirst = resolve;
        });
      }
      order.push(`end:${req.contents[0]}`);
      return { embeddings: [{ values: [1] }] };
    });
    const client = new ThrottledClient(innerCall, makeSettings({ maxConcurrency: 1 }));

    const firstPromise = client.call({ ...request, contents: ['first'] });
    const secondPromise = client.call({ ...request, contents: ['second'] });

    await vi.waitFor(() => expect(order).toEqual(['start:first']));
    resolveFirst?.();
    await Promise.all([firstPromise, secondPromise]);

    expect(order).toEqual(['start:first', 'end:first', 'start:second', 'end:second']);
  });

  it('bounds the request rate: a second call waits for the 60s window before starting', async () => {
    const starts: number[] = [];
    const innerCall = vi.fn(async (): Promise<EmbedContentResult> => {
      starts.push(Date.now());
      return { embeddings: [{ values: [1] }] };
    });
    const client = new ThrottledClient(innerCall, makeSettings({ requestsPerMinute: 1, maxConcurrency: 1000 }));

    const firstPromise = client.call(request);
    await vi.waitFor(() => expect(starts).toHaveLength(1));
    const secondPromise = client.call(request);

    // Give the second call a moment to attempt and block on the rate limiter.
    await vi.advanceTimersByTimeAsync(0);
    expect(starts).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(60_000);
    await Promise.all([firstPromise, secondPromise]);

    expect(starts).toHaveLength(2);
    expect(starts[1] - starts[0]).toBeGreaterThanOrEqual(60_000);
  });

  it('runs two independent instances with fully separate rate-limit and concurrency state', async () => {
    // Mirrors how GeminiLlmProvider wires embed and generate - amendment J's
    // "separate throttles" guarantee is that these two instances never
    // share a window or a slot, not just that they're configured with
    // different numbers.
    const embedCalls: number[] = [];
    const generateCalls: number[] = [];
    const embedClient = new ThrottledClient(
      vi.fn(async (): Promise<EmbedContentResult> => {
        embedCalls.push(Date.now());
        return { embeddings: [{ values: [1] }] };
      }),
      makeSettings({ requestsPerMinute: 1 }),
    );
    const generateClient = new ThrottledClient(
      vi.fn(async (): Promise<{ text?: string }> => {
        generateCalls.push(Date.now());
        return { text: '{}' };
      }),
      makeSettings({ requestsPerMinute: 1000 }),
    );

    await embedClient.call(request);
    await generateClient.call({});
    await generateClient.call({});

    expect(embedCalls).toHaveLength(1);
    expect(generateCalls).toHaveLength(2);
  });
});
