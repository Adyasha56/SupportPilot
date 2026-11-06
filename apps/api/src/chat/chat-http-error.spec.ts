import { describe, expect, it } from 'vitest';
import { chatHttpError, ChatErrorCode, statusForChatErrorCode } from './chat-http-error';

describe('statusForChatErrorCode', () => {
  it.each([
    ['INVALID_REQUEST', 400],
    ['REQUEST_TOO_LARGE', 413],
    ['INVALID_CUSTOMER_TOKEN', 401],
    ['NOT_CONFIGURED', 503],
    ['RATE_LIMITED', 429],
    ['BACKPRESSURE', 429],
    ['CONVERSATION_BUSY', 409],
    ['CONVERSATION_LENGTH_EXCEEDED', 409],
    ['PENDING_APPROVAL_WRITE_FAILED', 503],
    ['REQUEST_TIMEOUT', 503],
    ['INTERNAL_ERROR', 500],
  ] as [ChatErrorCode, number][])('%s maps to %d', (code, status) => {
    expect(statusForChatErrorCode(code)).toBe(status);
  });
});

describe('chatHttpError', () => {
  it('builds a {statusCode, code, message} body with the matching HTTP status', () => {
    const err = chatHttpError('INVALID_REQUEST', 'bad input');
    expect(err.getStatus()).toBe(400);
    expect(err.getResponse()).toEqual({ statusCode: 400, code: 'INVALID_REQUEST', message: 'bad input' });
  });

  it('includes retryAfterSeconds only when provided', () => {
    const withRetry = chatHttpError('RATE_LIMITED', 'slow down', 30);
    expect(withRetry.getResponse()).toEqual({ statusCode: 429, code: 'RATE_LIMITED', message: 'slow down', retryAfterSeconds: 30 });

    const withoutRetry = chatHttpError('RATE_LIMITED', 'slow down');
    expect(withoutRetry.getResponse()).toEqual({ statusCode: 429, code: 'RATE_LIMITED', message: 'slow down' });
  });
});
