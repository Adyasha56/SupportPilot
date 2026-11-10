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
 * The ONE pure, table-tested mapping from a tool-runner error code (plus
 * whether this is a retry) to amendment F4's four-way classification.
 * `isRetryAttempt` only changes the outcome for `CONFLICT` - every other
 * code's classification is context-independent. "Retry" here means
 * attemptCount was already > 1 when this attempt was made, which can only
 * happen via the retryable-failed or lease-takeover paths - both of which
 * already mean an earlier attempt's own outcome was uncertain, so "this
 * attempt follows one that may have reached the upstream" is exactly what
 * attemptCount > 1 means in this system, not a separate signal to track.
 */
export function classifyRefundExecutionFailure(code: ToolRunErrorCode, isRetryAttempt: boolean): RefundExecutionClassification {
  switch (code) {
    case 'CONFLICT':
      // A 409 "already refunded" on the FIRST attempt predates this run entirely - some other
      // channel did it, not us; a clean, definitive no. On a RETRY, our own earlier attempt most
      // likely already succeeded - this is not a plain failure, it needs a human to reconcile.
      return isRetryAttempt
        ? { failureClass: 'NEEDS_RECONCILIATION', retryable: false, upstreamMaybeReceived: true, rejectAllowed: false, staysActive: true }
        : { failureClass: 'DEFINITIVE', retryable: false, upstreamMaybeReceived: false, rejectAllowed: true, staysActive: false };

    case 'NOT_FOUND':
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
    // simply never got (or couldn't parse/fit) a clean confirmation either way.
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
