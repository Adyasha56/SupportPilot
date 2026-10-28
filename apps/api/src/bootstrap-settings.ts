import { z } from 'zod';

export const BootstrapSettingsSchema = z.object({
  /**
   * Passed straight to Express's `trust proxy` setting, which controls how
   * many hops of X-Forwarded-For are trusted when resolving req.ip (what
   * FailedAttemptLimiter keys on). Defaults to 0 - trust nothing, use the
   * direct socket address - which is the only safe default for code that
   * doesn't know its own deployment topology. A real deployment behind
   * exactly one reverse proxy (e.g. Render's free web service) sets this to
   * 1 via its own env config; this code never hardcodes that assumption.
   */
  trustProxyHops: z.number().int().nonnegative(),
});
export type BootstrapSettings = z.infer<typeof BootstrapSettingsSchema>;

export function loadBootstrapSettingsFromEnv(env: NodeJS.ProcessEnv): BootstrapSettings {
  const candidate = {
    trustProxyHops: Number(env.TRUST_PROXY_HOPS ?? 0),
  };

  const result = BootstrapSettingsSchema.safeParse(candidate);
  if (!result.success) {
    throw new Error(`Invalid BootstrapSettings: ${result.error.message}`);
  }
  return result.data;
}
