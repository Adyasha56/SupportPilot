import { Inject, Injectable, Optional } from '@nestjs/common';
import { AdminSessionRepository, ADMIN_SESSION_REPOSITORY } from '../db/admin-session.repository';
import { AdminPrincipal } from './admin-auth.guard';

export type AdminSessionBootstrapResult =
  | { kind: 'ok'; tenantId: string; csrfToken: string; absoluteExpiresAt: Date; idleExpiresAt: Date }
  | { kind: 'not_a_session_principal' }
  | { kind: 'not_found' };

/**
 * Milestone 5, Stage 1b, item 4 - the SPA's own bootstrap call and logout.
 * Both are cookie-session-only by design: `AdminAuthGuard` already resolved
 * SOME principal (header or cookie) before either method runs, so
 * "not_a_session_principal" covers an admin-scoped API key calling either
 * route, which is a bootstrap/logout for a browser SPA session that simply
 * doesn't exist for that caller.
 */
@Injectable()
export class AdminSessionService {
  constructor(@Optional() @Inject(ADMIN_SESSION_REPOSITORY) private readonly sessionRepository: AdminSessionRepository | undefined) {}

  async getBootstrap(principal: AdminPrincipal): Promise<AdminSessionBootstrapResult> {
    if (principal.kind !== 'session' || !principal.sessionId) {
      return { kind: 'not_a_session_principal' };
    }
    if (!this.sessionRepository) {
      return { kind: 'not_found' };
    }
    // Re-read rather than trust the guard's own request-scoped snapshot - this is a cheap,
    // infrequent bootstrap call, not a hot path, so the extra read is worth the freshness
    // (e.g. picking up the lastSeenAt the guard itself may have just written this request).
    const session = await this.sessionRepository.findById(principal.sessionId);
    if (!session) {
      return { kind: 'not_found' };
    }
    return {
      kind: 'ok',
      tenantId: session.tenantId,
      csrfToken: session.csrfToken,
      absoluteExpiresAt: session.absoluteExpiresAt,
      idleExpiresAt: new Date(session.lastSeenAt.getTime() + session.idleTimeoutMs),
    };
  }

  async logout(principal: AdminPrincipal): Promise<void> {
    if (principal.kind !== 'session' || !principal.sessionId || !this.sessionRepository) {
      return;
    }
    await this.sessionRepository.deleteById(principal.sessionId);
  }
}
