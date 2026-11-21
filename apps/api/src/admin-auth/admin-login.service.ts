import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { AdminCredentialRepository, ADMIN_CREDENTIAL_REPOSITORY } from '../db/admin-credential.repository';
import { AdminSessionRepository, ADMIN_SESSION_REPOSITORY } from '../db/admin-session.repository';
import { RateLimiter } from '../auth/rate-limiter';
import { computeLockedUntil } from './lockout';
import { HashConcurrencyLimiter, verifyDummyHash, verifyPasswordHash } from './password-hash';
import { hashSessionToken, mintCsrfToken, mintSessionToken } from './session-token';
import { AdminAuthSettings } from './admin-auth.settings';
import { ADMIN_AUTH_SETTINGS } from './admin-auth-settings.provider';
import { ADMIN_LOGIN_IP_RATE_LIMITER } from './admin-login-rate-limiter.provider';
import { ADMIN_HASH_CONCURRENCY_LIMITER } from './hash-concurrency-limiter.provider';

export const GENERIC_INVALID_CREDENTIALS_MESSAGE = 'Invalid email or password.';

export type AdminLoginResult =
  | {
      kind: 'success';
      tenantId: string;
      rawSessionToken: string;
      csrfToken: string;
      absoluteExpiresAt: Date;
      idleTimeoutMs: number;
    }
  | { kind: 'invalid_credentials' }
  | { kind: 'rate_limited'; retryAfterSeconds: number }
  | { kind: 'hash_queue_full' };

/**
 * Milestone 5, Stage 1b, items 2/3 - the whole login decision in one
 * place: per-IP limiter -> email lookup -> EITHER the dummy-hash path
 * (unknown email OR a currently-locked account - item 2's explicit
 * timing-safety requirement: a locked account's REAL password is never
 * even compared, only the dummy, so correctly guessing the real password
 * while locked out reveals nothing either) OR the real verification path.
 * Every failure path (unknown email, locked, wrong password) returns the
 * byte-identical `{kind: 'invalid_credentials'}` - the controller maps
 * this to ONE fixed generic message and status, never distinguishing why.
 */
@Injectable()
export class AdminLoginService {
  private readonly logger = new Logger(AdminLoginService.name);
  private readonly clock: () => Date;

  constructor(
    @Optional() @Inject(ADMIN_CREDENTIAL_REPOSITORY) private readonly credentialRepository: AdminCredentialRepository | undefined,
    @Optional() @Inject(ADMIN_SESSION_REPOSITORY) private readonly sessionRepository: AdminSessionRepository | undefined,
    @Inject(ADMIN_AUTH_SETTINGS) private readonly settings: AdminAuthSettings,
    @Inject(ADMIN_LOGIN_IP_RATE_LIMITER) private readonly ipRateLimiter: RateLimiter,
    @Inject(ADMIN_HASH_CONCURRENCY_LIMITER) private readonly hashLimiter: HashConcurrencyLimiter,
    @Optional() clock?: () => Date,
  ) {
    this.clock = clock ?? (() => new Date());
  }

  async login(input: { email: string; password: string; clientIp: string; presentedRawSessionToken?: string }): Promise<AdminLoginResult> {
    if (!this.credentialRepository || !this.sessionRepository) {
      // No database at all - still a failed login, never a 503 that would distinguish
      // "not configured" from "wrong password" to an unauthenticated caller.
      return { kind: 'invalid_credentials' };
    }

    const ipDecision = this.ipRateLimiter.tryConsume(input.clientIp);
    if (!ipDecision.allowed) {
      return { kind: 'rate_limited', retryAfterSeconds: Math.ceil(ipDecision.retryAfterMs / 1000) };
    }

    const normalizedEmail = input.email.trim().toLowerCase();
    const credential = await this.credentialRepository.findByEmail(normalizedEmail);
    const now = this.clock();
    const isLocked = Boolean(credential?.lockedUntil && credential.lockedUntil.getTime() > now.getTime());

    if (!credential || isLocked) {
      const dummyResult = await this.hashLimiter.run(() => verifyDummyHash(input.password));
      if (!dummyResult.ok) {
        return { kind: 'hash_queue_full' };
      }
      this.audit('login_failed', credential?.tenantId, isLocked ? 'LOCKED' : 'UNKNOWN_EMAIL');
      return { kind: 'invalid_credentials' };
    }

    const verifyResult = await this.hashLimiter.run(() => verifyPasswordHash(input.password, credential.passwordHash));
    if (!verifyResult.ok) {
      return { kind: 'hash_queue_full' };
    }

    if (!verifyResult.value) {
      const lockedUntil = computeLockedUntil(credential.failedAttempts + 1, now, {
        freeAttempts: this.settings.lockoutFreeAttempts,
        baseMs: this.settings.lockoutBaseMs,
        capMs: this.settings.lockoutCapMs,
      });
      await this.credentialRepository.incrementFailedAttempts(credential.tenantId, lockedUntil);
      this.audit('login_failed', credential.tenantId, 'WRONG_PASSWORD');
      return { kind: 'invalid_credentials' };
    }

    // Success. Reset the lockout counters, then (anti-fixation - item 3) invalidate whatever
    // session cookie the request ALREADY presented, if any, before minting the new one - a
    // pre-set cookie value can never silently "become" authenticated by surviving a login.
    await this.credentialRepository.resetFailedAttempts(credential.tenantId);
    if (input.presentedRawSessionToken) {
      const priorSession = await this.sessionRepository.findByTokenHash(hashSessionToken(input.presentedRawSessionToken));
      if (priorSession) {
        await this.sessionRepository.deleteById(priorSession.id);
      }
    }

    const rawSessionToken = mintSessionToken();
    const csrfToken = mintCsrfToken();
    const absoluteExpiresAt = new Date(now.getTime() + this.settings.sessionAbsoluteLifetimeMs);
    await this.sessionRepository.create({
      tenantId: credential.tenantId,
      principalId: credential.tenantId,
      tokenHash: hashSessionToken(rawSessionToken),
      csrfToken,
      lastSeenAt: now,
      absoluteExpiresAt,
      idleTimeoutMs: this.settings.sessionIdleTimeoutMs,
    });

    this.audit('login_succeeded', credential.tenantId);
    return {
      kind: 'success',
      tenantId: credential.tenantId,
      rawSessionToken,
      csrfToken,
      absoluteExpiresAt,
      idleTimeoutMs: this.settings.sessionIdleTimeoutMs,
    };
  }

  /** Item 9 - ids and outcome codes only, NEVER email/password/token/cookie value. */
  private audit(event: 'login_succeeded' | 'login_failed', tenantId?: string, outcomeCode?: string): void {
    this.logger.log(JSON.stringify({ event, ...(tenantId ? { tenantId } : {}), ...(outcomeCode ? { outcomeCode } : {}) }));
  }
}
