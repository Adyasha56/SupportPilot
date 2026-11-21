import { z } from 'zod';

/**
 * Milestone 5, Stage 1b - POST /v1/admin/login. Validated before anything
 * else touches the request (lockout check, hashing, etc.) - a malformed
 * body never reaches the password-hashing path at all.
 */
export const AdminLoginRequestSchema = z.object({
  email: z.string().min(1).max(320),
  password: z.string().min(1).max(1000),
});
export type AdminLoginRequest = z.infer<typeof AdminLoginRequestSchema>;

/**
 * GET /v1/admin/session - the SPA's own bootstrap call, cookie-authenticated
 * only. `csrfToken` is the ONLY copy of the synchronizer token the client
 * ever sees in cleartext - it lives server-side on the session row
 * otherwise (no readable CSRF cookie) and must be echoed back in a header
 * on every state-changing request.
 */
export const AdminSessionBootstrapSchema = z.object({
  tenantId: z.string(),
  csrfToken: z.string(),
  absoluteExpiresAt: z.string(),
  idleExpiresAt: z.string(),
});
export type AdminSessionBootstrap = z.infer<typeof AdminSessionBootstrapSchema>;
