import { describe, expect, it } from 'vitest';
import { classifyRefundExecutionFailure } from './refund-execution-classification';
import { ToolRunErrorCode } from '../agent/tool-runner/tool-runner';

describe('classifyRefundExecutionFailure (amendments F4, G1, G2)', () => {
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
    // Amendment G1 - a 4xx (400/422) rejection is its own DEFINITIVE code, same shape as NOT_FOUND.
    ['UPSTREAM_REJECTED', { failureClass: 'DEFINITIVE', retryable: false, upstreamMaybeReceived: false, rejectAllowed: true, staysActive: false }],
  ])('%s classifies as %o, regardless of priorAttemptMayHaveReachedUpstream', (code, expected) => {
    expect(classifyRefundExecutionFailure(code, false)).toEqual(expected);
    expect(classifyRefundExecutionFailure(code, true)).toEqual(expected);
  });

  it('CONFLICT with no prior attempt reaching the upstream is DEFINITIVE (predates this run - some other channel refunded it)', () => {
    expect(classifyRefundExecutionFailure('CONFLICT', false)).toEqual({
      failureClass: 'DEFINITIVE',
      retryable: false,
      upstreamMaybeReceived: false,
      rejectAllowed: true,
      staysActive: false,
    });
  });

  it('CONFLICT when a prior attempt may have reached the upstream is NEEDS_RECONCILIATION', () => {
    expect(classifyRefundExecutionFailure('CONFLICT', true)).toEqual({
      failureClass: 'NEEDS_RECONCILIATION',
      retryable: false,
      upstreamMaybeReceived: true,
      rejectAllowed: false,
      staysActive: true,
    });
  });

  it('amendment G2: a retry AFTER a NOT_SENT failure that then gets a 409 is still DEFINITIVE, not NEEDS_RECONCILIATION - this is the whole point of keying off upstreamMaybeReceived, not "is this a retry"', () => {
    // Simulates the real sequence: attempt 1 fails NOT_SENT (upstreamMaybeReceived: false is
    // what gets stored on the Approval); attempt 2 (a genuine retry) then gets a 409. The
    // caller passes the STORED value from attempt 1, not "true because this is attempt 2".
    const firstAttempt = classifyRefundExecutionFailure('SECRET_NOT_CONFIGURED', false);
    expect(firstAttempt.upstreamMaybeReceived).toBe(false);

    const retryResult = classifyRefundExecutionFailure('CONFLICT', firstAttempt.upstreamMaybeReceived);
    expect(retryResult.failureClass).toBe('DEFINITIVE');
    expect(retryResult.rejectAllowed).toBe(true);
  });

  it('amendment G2: a retry AFTER an AMBIGUOUS failure that then gets a 409 IS NEEDS_RECONCILIATION', () => {
    const firstAttempt = classifyRefundExecutionFailure('TIMEOUT', false);
    expect(firstAttempt.upstreamMaybeReceived).toBe(true);

    const retryResult = classifyRefundExecutionFailure('CONFLICT', firstAttempt.upstreamMaybeReceived);
    expect(retryResult.failureClass).toBe('NEEDS_RECONCILIATION');
    expect(retryResult.rejectAllowed).toBe(false);
  });

  it('every NOT_SENT and DEFINITIVE code allows reject; every AMBIGUOUS and NEEDS_RECONCILIATION code blocks it', () => {
    expect(classifyRefundExecutionFailure('INVALID_INPUT', false).rejectAllowed).toBe(true);
    expect(classifyRefundExecutionFailure('NOT_FOUND', false).rejectAllowed).toBe(true);
    expect(classifyRefundExecutionFailure('UPSTREAM_REJECTED', false).rejectAllowed).toBe(true);
    expect(classifyRefundExecutionFailure('TIMEOUT', false).rejectAllowed).toBe(false);
    expect(classifyRefundExecutionFailure('CONFLICT', true).rejectAllowed).toBe(false);
  });
});
