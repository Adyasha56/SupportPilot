import { RefundExecutionFailureClass, TOOL_RUN_ERROR_CODES } from '@supportpilot/shared';
import { ToolRunErrorCode } from '../agent/tool-runner/tool-runner';

/**
 * Compile-time guard against packages/shared/src/approval-schemas.ts's
 * TOOL_RUN_ERROR_CODES drifting from the real ToolRunErrorCode union it
 * mirrors (shared sits below apps/api and can't import from it, so this is
 * duplicated by hand there) - if ToolRunErrorCode ever gains a member this
 * object doesn't have, the assignment below fails to compile.
 */
const _mirrorCheck: Record<(typeof TOOL_RUN_ERROR_CODES)[number], true> = {
  INVALID_INPUT: true,
  CONFIG_ERROR: true,
  SECRET_NOT_CONFIGURED: true,
  BLOCKED_BY_POLICY: true,
  TIMEOUT: true,
  NOT_FOUND: true,
  CONFLICT: true,
  UPSTREAM_AUTH_FAILED: true,
  UPSTREAM_ERROR: true,
  UPSTREAM_REJECTED: true,
  RESPONSE_TOO_LARGE: true,
  INVALID_RESPONSE: true,
};
void _mirrorCheck;

export interface RefundExecutionClassification {
  failureClass: RefundExecutionFailureClass;
  /** May the Approval be retried (via approve again) by us? */
  retryable: boolean;
  /** Might the refund actually have been applied upstream? Independent of `retryable`. */
  upstreamMaybeReceived: boolean;
  /** May an admin `reject` the Approval while it sits in this state? */
  rejectAllowed: boolean;
  /** Should `active` stay true (continue blocking a fresh proposal for the same order)? */
  staysActive: boolean;
}

/**
 * The ONE pure, table-tested mapping from a tool-runner error code to
 * amendment F4's four-way classification.
 *
 * `priorAttemptMayHaveReachedUpstream` (amendment G2) is the ONLY context
 * this function needs beyond the code itself, and it only changes the
 * outcome for `CONFLICT`. It is NOT "is this a retry" (attemptCount > 1) -
 * it is specifically the Approval's own currently-stored
 * `upstreamMaybeReceived` value from whatever attempt immediately preceded
 * this one (false on a genuine first attempt, or on any attempt that
 * follows only NOT_SENT failures so far - a NOT_SENT failure is, by
 * definition, confident nothing reached the upstream, so a 409 after one
 * or more of those still means "this predates us entirely", not "we
 * caused it"). It only becomes true once some attempt actually got an
 * AMBIGUOUS (or earlier NEEDS_RECONCILIATION) outcome - the caller
 * (ApprovalService) reads this straight off the Approval record it
 * already has before calling the runner, never recomputes it.
 */
export function classifyRefundExecutionFailure(code: ToolRunErrorCode, priorAttemptMayHaveReachedUpstream: boolean): RefundExecutionClassification {
  switch (code) {
    case 'CONFLICT':
      // A 409 "already refunded" is DEFINITIVE (predates this run entirely - some other channel
      // did it, not us) UNLESS a previous attempt of OUR OWN may already have reached the
      // upstream, in which case it most likely explains the 409 itself - not a plain failure,
      // needs a human to reconcile.
      return priorAttemptMayHaveReachedUpstream
        ? { failureClass: 'NEEDS_RECONCILIATION', retryable: false, upstreamMaybeReceived: true, rejectAllowed: false, staysActive: true }
        : { failureClass: 'DEFINITIVE', retryable: false, upstreamMaybeReceived: false, rejectAllowed: true, staysActive: false };

    // DEFINITIVE: a clean, explicit "no" from upstream - the request was received and rejected,
    // never applied. NOT_FOUND (no such order) and UPSTREAM_REJECTED (400/422 - "this exact
    // request is invalid", amendment G1) both land here, distinct from UPSTREAM_ERROR's
    // 5xx/unknown-status bucket below.
    case 'NOT_FOUND':
    case 'UPSTREAM_REJECTED':
      return { failureClass: 'DEFINITIVE', retryable: false, upstreamMaybeReceived: false, rejectAllowed: true, staysActive: false };

    // NOT_SENT: confident the refund-issuing request never meaningfully reached the upstream
    // refund operation at all (our own config/validation/policy refused it before sending, or
    // the upstream rejected the credentials before doing anything with the refund itself).
    case 'INVALID_INPUT':
    case 'CONFIG_ERROR':
    case 'SECRET_NOT_CONFIGURED':
    case 'BLOCKED_BY_POLICY':
    case 'UPSTREAM_AUTH_FAILED':
      return { failureClass: 'NOT_SENT', retryable: true, upstreamMaybeReceived: false, rejectAllowed: true, staysActive: true };

    // AMBIGUOUS: the request may well have reached and been processed by the upstream - we
    // simply never got (or couldn't parse/fit) a clean confirmation either way. 5xx
    // (UPSTREAM_ERROR, which also covers any status this project has no specific evidence
    // about) deliberately stays here, never promoted to DEFINITIVE.
    case 'TIMEOUT':
    case 'UPSTREAM_ERROR':
    case 'RESPONSE_TOO_LARGE':
    case 'INVALID_RESPONSE':
      return { failureClass: 'AMBIGUOUS', retryable: true, upstreamMaybeReceived: true, rejectAllowed: false, staysActive: true };

    default: {
      const exhaustive: never = code;
      throw new Error(`classifyRefundExecutionFailure: unhandled ToolRunErrorCode "${String(exhaustive)}".`);
    }
  }
}
