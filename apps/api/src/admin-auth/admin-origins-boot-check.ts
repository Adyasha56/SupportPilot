/**
 * Milestone 5, Part 0, item Q3 - `ADMIN_ALLOWED_ORIGINS` empty is a
 * deliberate fail-closed default (admin-auth.settings.ts's own doc
 * comment: every cookie-authenticated non-GET admin request is refused
 * until it's configured). That is correct and safe, but silent - an
 * operator who forgets to set it in a real deployment would only
 * discover the problem when the (not-yet-built) admin console's first
 * state-changing request mysteriously 401s. This is a one-line BOOT-TIME
 * warning, never a value with any potential for ambiguity about what's
 * logged: a count and a boolean only, matching this project's existing
 * "never log anything that could itself be sensitive" discipline even
 * though an origin list isn't secret - there's simply no reason to log
 * it when the count alone is all an operator needs to notice the gap.
 */
export interface AdminOriginsBootCheckResult {
  shouldWarn: boolean;
  allowedOriginsCount: number;
  nodeEnvIsProduction: boolean;
}

export function checkAdminOriginsAtBoot(allowedOrigins: string[], nodeEnv: string | undefined): AdminOriginsBootCheckResult {
  const nodeEnvIsProduction = nodeEnv === 'production';
  const allowedOriginsCount = allowedOrigins.length;
  return {
    shouldWarn: nodeEnvIsProduction && allowedOriginsCount === 0,
    allowedOriginsCount,
    nodeEnvIsProduction,
  };
}

export function warnIfAdminOriginsMisconfigured(allowedOrigins: string[], nodeEnv: string | undefined, warn: (message: string) => void): void {
  const result = checkAdminOriginsAtBoot(allowedOrigins, nodeEnv);
  if (result.shouldWarn) {
    warn(
      JSON.stringify({
        event: 'admin_allowed_origins_empty_in_production',
        allowedOriginsCount: result.allowedOriginsCount,
        nodeEnvIsProduction: result.nodeEnvIsProduction,
      }),
    );
  }
}
