import { z } from 'zod';

export const ToolRunnerSettingsSchema = z.object({
  /**
   * Server-level only - a connector's own config can never add to this.
   * Empty is a valid, safe default (blocks every connector) so the app can
   * still boot with no tool-runner env configured, rather than crash.
   */
  hostAllowlist: z.array(z.string().min(1)),
  allowPrivateNetworks: z.boolean(),
  requestTimeoutMs: z.number().int().positive(),
  maxResponseBytes: z.number().int().positive(),
  requireHttps: z.boolean(),
});
export type ToolRunnerSettings = z.infer<typeof ToolRunnerSettingsSchema>;

/**
 * Built ONCE at startup from env. The guard and the tool runner never read
 * process.env themselves - everything flows through this typed object, so
 * tests can pass their own settings without touching real env state.
 */
export function loadToolRunnerSettingsFromEnv(env: NodeJS.ProcessEnv): ToolRunnerSettings {
  const hostAllowlist = (env.CONNECTOR_HOST_ALLOWLIST ?? '')
    .split(',')
    .map((host) => host.trim().toLowerCase())
    .filter((host) => host.length > 0);

  const isDevOrTest = env.NODE_ENV === 'development' || env.NODE_ENV === 'test';

  const candidate = {
    hostAllowlist,
    allowPrivateNetworks: isDevOrTest && env.ALLOW_PRIVATE_NETWORKS === 'true',
    requestTimeoutMs: Number(env.CONNECTOR_REQUEST_TIMEOUT_MS ?? 5000),
    maxResponseBytes: Number(env.CONNECTOR_MAX_RESPONSE_BYTES ?? 1_000_000),
    requireHttps: !isDevOrTest,
  };

  const result = ToolRunnerSettingsSchema.safeParse(candidate);
  if (!result.success) {
    throw new Error(`Invalid ToolRunnerSettings: ${result.error.message}`);
  }
  return result.data;
}
