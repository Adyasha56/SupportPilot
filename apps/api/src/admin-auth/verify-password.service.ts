import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { AdminCredentialRepository, ADMIN_CREDENTIAL_REPOSITORY } from '../db/admin-credential.repository';
import { computeLockedUntil } from './lockout';
import { HashConcurrencyLimiter, verifyDummyHash, verifyPasswordHash } from './password-hash';
import { rehashOnLoginIfWeak } from './rehash-on-login';
import { AdminAuthSettings } from './admin-auth.settings';
import { ADMIN_AUTH_SETTINGS } from './admin-auth-settings.provider';
import { ADMIN_HASH_CONCURRENCY_LIMITER } from './hash-concurrency-limiter.provider';
import { AdminPrincipal } from './admin-auth.guard';

export type VerifyPasswordResult = { kind: 'ok' } | { kind: 'invalid_password' } | { kind: 'not_session_principal' } | { kind: 'queue_full' } | { kind: 'not_configured' };

/**
 * Milestone 5, Stage 1b, item 7 - the STEP-UP primitive. Documented design
 * (the actual settings-change endpoint this guards is Stage 1c, not built
 * yet):
 *
 *   Enabling `autoExecuteRefunds` or raising `refundCap` requires the
 *   CALLER to be a session principal (`kind: 'session'`) - an admin API
 *   key can authenticate every other `/v1/approvals*`/future settings-read
 *   route, but can NEVER authorize either of these two specific changes,
 *   full stop. This is enforced HERE, structurally (a non-session
 *   principal gets `not_session_principal` before any password is even
 *   looked at), not left to the future settings controller to remember -
 *   the same "enforce the real rule in the one place it can't be
 *   bypassed" discipline this project already applies to `issue_refund`
 *   (RULES.md section 5's permanent rule) and the privileged refund
 *   runner. The password is re-verified through the EXACT same path a
 *   login uses - same scrypt parameters, same `HashConcurrencyLimiter`
 *   (so a step-up flood can't exhaust more memory than a login flood
 *   already could), same lockout counters on the credential (a wrong
 *   step-up password counts toward the SAME `failedAttempts`/
 *   `lockedUntil` a wrong login password would, and a currently-locked
 *   credential verifies against the dummy hash here too, never the real
 *   one) - a step-up attempt is, deliberately, not a separate attack
 *   surface with its own, possibly weaker, rules.
 */
@Injectable()
export class VerifyPasswordService {
  private readonly logger = new Logger(VerifyPasswordService.name);
  private readonly clock: () => Date;

  constructor(
    @Optional() @Inject(ADMIN_CREDENTIAL_REPOSITORY) private readonly credentialRepository: AdminCredentialRepository | undefined,
    @Inject(ADMIN_AUTH_SETTINGS) private readonly settings: AdminAuthSettings,
    @Inject(ADMIN_HASH_CONCURRENCY_LIMITER) private readonly hashLimiter: HashConcurrencyLimiter,
    @Optional() clock?: () => Date,
  ) {
    this.clock = clock ?? (() => new Date());
  }

  async verifyPassword(principal: AdminPrincipal, password: string): Promise<VerifyPasswordResult> {
    if (principal.kind !== 'session') {
      return { kind: 'not_session_principal' };
    }
    if (!this.credentialRepository) {
      return { kind: 'not_configured' };
    }

    const credential = await this.credentialRepository.findByTenantId(principal.tenantId);
    const now = this.clock();
    const isLocked = Boolean(credential?.lockedUntil && credential.lockedUntil.getTime() > now.getTime());

    if (!credential || isLocked) {
      const dummyResult = await this.hashLimiter.run(() => verifyDummyHash(password));
      if (!dummyResult.ok) {
        return { kind: 'queue_full' };
      }
      this.audit(principal.tenantId, isLocked ? 'LOCKED' : 'NO_CREDENTIAL');
      return { kind: 'invalid_password' };
    }

    const verifyResult = await this.hashLimiter.run(() => verifyPasswordHash(password, credential.passwordHash));
    if (!verifyResult.ok) {
      return { kind: 'queue_full' };
    }
    if (!verifyResult.value) {
      const lockedUntil = computeLockedUntil(credential.failedAttempts + 1, now, {
        freeAttempts: this.settings.lockoutFreeAttempts,
        baseMs: this.settings.lockoutBaseMs,
        capMs: this.settings.lockoutCapMs,
      });
      await this.credentialRepository.incrementFailedAttempts(credential.tenantId, lockedUntil);
      this.audit(principal.tenantId, 'WRONG_PASSWORD');
      return { kind: 'invalid_password' };
    }

    await this.credentialRepository.resetFailedAttempts(credential.tenantId);
    await rehashOnLoginIfWeak(this.credentialRepository, this.hashLimiter, credential.tenantId, password, credential.passwordHash);
    this.audit(principal.tenantId, 'OK');
    return { kind: 'ok' };
  }

  private audit(tenantId: string, outcomeCode: string): void {
    this.logger.log(JSON.stringify({ event: 'step_up_password_verify', tenantId, outcomeCode }));
  }
}
