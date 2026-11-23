import { Logger } from '@nestjs/common';
import { AdminCredentialRepository } from '../db/admin-credential.repository';
import { HashConcurrencyLimiter, hashPassword, storedHashIsWeak } from './password-hash';

const logger = new Logger('RehashOnLogin');

/**
 * Part 0, item Q1 - "implement rehash-on-successful-login when stored
 * parameters are weaker than current". Called ONLY after a password has
 * ALREADY verified successfully against the (possibly weak) stored hash -
 * never influences the login/step-up decision itself, and never runs at
 * all on a failed attempt. Shared by AdminLoginService and
 * VerifyPasswordService so both paths rehash the same way, through the
 * SAME `HashConcurrencyLimiter` (a rehash costs a real scrypt call and
 * must count against the same memory budget as any other one, never a
 * second, unaccounted concurrent hash).
 *
 * Awaited inline (synchronous with the request), not fire-and-forget -
 * correctness and testability over shaving ~150ms off an already-
 * infrequent admin login/step-up call. If the queue is full, rehashing is
 * simply skipped for this attempt (logged, never surfaced as a failure to
 * the caller) - the NEXT successful login tries again; a transparent
 * background upgrade is never allowed to turn a real, successful
 * authentication into a failure.
 */
export async function rehashOnLoginIfWeak(
  credentialRepository: AdminCredentialRepository,
  hashLimiter: HashConcurrencyLimiter,
  tenantId: string,
  password: string,
  storedHash: string,
): Promise<void> {
  if (!storedHashIsWeak(storedHash)) {
    return;
  }
  const result = await hashLimiter.run(() => hashPassword(password));
  if (!result.ok) {
    logger.warn(JSON.stringify({ event: 'rehash_skipped_queue_full', tenantId }));
    return;
  }
  await credentialRepository.updatePasswordHash(tenantId, result.value);
  logger.log(JSON.stringify({ event: 'rehash_on_login', tenantId }));
}
