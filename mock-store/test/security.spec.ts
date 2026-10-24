import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { createTestApp, authHeader, TEST_TOKEN } from './helpers';

describe('malformed and oversized request bodies', () => {
  it('returns a generic 400 for malformed JSON, with no stack trace', async () => {
    const res = await request(createTestApp())
      .post('/escalations')
      .set('Authorization', authHeader())
      .set('Content-Type', 'application/json')
      .send('{not valid json');

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'Invalid request body' });
    const raw = JSON.stringify(res.body);
    expect(raw).not.toMatch(/at \w+/); // no stack-trace-shaped content
    expect(raw).not.toContain('SyntaxError');
  });

  it('returns a generic 413 for a body over the size limit', async () => {
    const res = await request(createTestApp())
      .post('/escalations')
      .set('Authorization', authHeader())
      .send({ summary: 'a'.repeat(200_000) });

    expect(res.status).toBe(413);
    expect(res.body).toEqual({ error: 'Invalid request body' });
  });
});

describe('nothing sensitive is ever logged', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function allLoggedText(): string {
    const allCalls = [...logSpy.mock.calls, ...errorSpy.mock.calls, ...warnSpy.mock.calls];
    return allCalls.map((call) => call.map(String).join(' ')).join('\n');
  }

  it('never logs the bearer token, across success, auth failure, and parse failure', async () => {
    const app = createTestApp();

    await request(app).get('/orders/ORD-1001').set('Authorization', authHeader());
    await request(app).get('/orders/ORD-1001').set('Authorization', authHeader('wrong-token'));
    await request(app)
      .post('/escalations')
      .set('Authorization', authHeader())
      .set('Content-Type', 'application/json')
      .send('{not valid json');

    expect(allLoggedText()).not.toContain(TEST_TOKEN);
  });

  it('never logs a customerRef value when returning order data', async () => {
    const app = createTestApp();
    await request(app).get('/orders/ORD-1001').set('Authorization', authHeader());

    expect(allLoggedText()).not.toContain('cust_1');
  });
});
