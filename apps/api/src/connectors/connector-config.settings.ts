import { z } from 'zod';

export const ConnectorConfigSettingsSchema = z.object({
  /**
   * No default, deliberately. When unset, connectors are DISABLED - the
   * app still boots (connectorConfigRepositoryProvider wires in
   * DisabledConnectorConfigRepository instead of failing), and every tool
   * call returns CONFIG_ERROR, the same outcome an unconfigured connector
   * already produces today. Must point at a directory of per-tenant
   * subdirectories of connector JSON files (the shape
   * FileConnectorConfigRepository expects) - in local dev this is the
   * SOURCE fixtures directory (apps/api/src/connectors/fixtures); this
   * directory is never bundled into the Nest build output or the
   * production Docker image (see docs/learning-notes.md for the
   * reasoning and PROJECT.md section 13 for where production connector
   * configs should come from instead).
   */
  connectorConfigDir: z.string().min(1).optional(),
});
export type ConnectorConfigSettings = z.infer<typeof ConnectorConfigSettingsSchema>;

export function loadConnectorConfigSettingsFromEnv(env: NodeJS.ProcessEnv): ConnectorConfigSettings {
  const candidate = { connectorConfigDir: env.CONNECTOR_CONFIG_DIR || undefined };
  const result = ConnectorConfigSettingsSchema.safeParse(candidate);
  if (!result.success) {
    throw new Error(`Invalid ConnectorConfigSettings: ${result.error.message}`);
  }
  return result.data;
}
