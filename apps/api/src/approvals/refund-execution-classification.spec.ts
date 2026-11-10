import { describe, expect, it } from 'vitest';
import { classifyRefundExecutionFailure } from './refund-execution-classification';
import { ToolRunErrorCode } from '../agent/tool-runner/tool-runner';

describe('classifyRefundExecutionFailure (amendment F4)', () => {
  it.each<[ToolRunErrorCode, ReturnType<typeof classifyRefundExecutionFailure>]>([
    ['INVALID_INPUT', { failureClass: 'NOT_SENT', retryable: true, upstreamMaybeReceived: false, rejectAllowed: true, staysActive: true }],
    ['CONFIG_ERROR', { failureClass: 'NOT_SENT', retryable: true, upstreamMaybeReceived: false, rejectAllowed: true, staysActive: true }],
    ['SECRET_NOT_CONFIGURED', { failureClass: 'NOT_SENT', retryable: true, upstreamMaybeReceived: false, rejectAllowed: true, staysActive: true }],
    ['BLOCKED_BY_POLICY', { failureClass: 'NOT_SENT', retryable: true, upstreamMaybeReceived: false, rejectAllowed: true, staysActive: true }],
    ['UPSTREAM_AUTH_FAILED', { failureClass: 'NOT_SENT', retryable: true, upstreamMaybeReceived: false, rejectAllowed: true, staysActive: true }],
    ['TIMEOUT', { failureClass: 'AMBIGUOUS', retryable: true, upstreamMaybeReceived: true, rejectAllowed: false, staysActive: true }],
    ['UPSTREAM_ERROR', { failureClass: 'AMBIGUOUS', retryable: true, upstreamMaybeReceived: true, rejectAllowed: false, staysActive: true }],
    ['RESPONSE_TOO_LARGE', { failureClass: 'AMBIGUOUS', retryable: true, upstreamMaybeReceived: true, rejectAllowed: false, staysActive: true }],
    ['INVALID_RESPONSE', { failureClass: 'AMBIGUOUS', retryable: true, upstreamMaybeReceived: true, rejectAllowed: false, staysActive: true }],
    ['NOT_FOUND', { failureClass: 'DEFINITIVE', retryable: false, upstreamMaybeReceived: false, rejectAllowed: true, staysActive: false }],
  ])('%s on a FIRST attempt classifies as %o', (code, expected) => {
    expect(classifyRefundExecutionFailure(code, false)).toEqual(expected);
  });

  it('CONFLICT on a FIRST attempt is DEFINITIVE (predates this run - some other channel refunded it)', () => {
    expect(classifyRefundExecutionFailure('CONFLICT', false)).toEqual({
      failureClass: 'DEFINITIVE',
      retryable: false,
      upstreamMaybeReceived: false,
      rejectAllowed: true,
      staysActive: false,
    });
  });

  it('CONFLICT on a RETRY is NEEDS_RECONCILIATION (our own earlier attempt likely already succeeded)', () => {
    expect(classifyRefundExecutionFailure('CONFLICT', true)).toEqual({
      failureClass: 'NEEDS_RECONCILIATION',
      retryable: false,
      upstreamMaybeReceived: true,
      rejectAllowed: false,
      staysActive: true,
    });
  });

  it('isRetryAttempt never changes the classification for any code other than CONFLICT', () => {
    const codes: ToolRunErrorCode[] = [
      'INVALID_INPUT',
      'CONFIG_ERROR',
      'SECRET_NOT_CONFIGURED',
      'BLOCKED_BY_POLICY',
      'UPSTREAM_AUTH_FAILED',
      'TIMEOUT',
      'UPSTREAM_ERROR',
      'RESPONSE_TOO_LARGE',
      'INVALID_RESPONSE',
      'NOT_FOUND',
    ];
    for (const code of codes) {
      expect(classifyRefundExecutionFailure(code, true)).toEqual(classifyRefundExecutionFailure(code, false));
    }
  });

  it('every NOT_SENT and DEFINITIVE code allows reject; every AMBIGUOUS and NEEDS_RECONCILIATION code blocks it', () => {
    expect(classifyRefundExecutionFailure('INVALID_INPUT', false).rejectAllowed).toBe(true);
    expect(classifyRefundExecutionFailure('NOT_FOUND', false).rejectAllowed).toBe(true);
    expect(classifyRefundExecutionFailure('TIMEOUT', false).rejectAllowed).toBe(false);
    expect(classifyRefundExecutionFailure('CONFLICT', true).rejectAllowed).toBe(false);
  });
});
