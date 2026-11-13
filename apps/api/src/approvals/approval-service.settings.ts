import { z } from 'zod';

/**
 * Stage 5 follow-up: `ApprovalServiceSettings` (approval.service.ts) was env-var-configurable in
 * NAME only through Stage 4 - the real DI wiring (approvals.module.ts) never actually provided
 * a value for the constructor's optional `settings` parameter, so production always silently ran
 * on the hardcoded `DEFAULT_SETTINGS` regardless of any env var. Now that Stage 5 wires the
 * auto-execute path into a real, live HTTP request for the first time, both knobs are worth being
 * able to tune without a code change - same env-var-driven, Zod-validated pattern as
 * run-agent.settings.ts's own `loadRunAgentDeadlineSettingsFromEnv`.
 */
export const ApprovalServiceEnvSettingsSchema = z.object({
  /** Amendment B - how long an `executing` row blocks a second decision attempt before a lease takeover is allowed. Default 60s: roughly 2x a typical connector call timeout plus margin. */
  executionLeaseMs: z.number().int().positive(),
  /** Amendment J - the auto-execute path's own bounded timeout, strictly inside the remaining HTTP deadline (chat.settings.ts's httpDeadlineMs). Default 15s - comfortably inside that deadline with margin for the rest of the chat pipeline's own work. */
  autoExecuteTimeoutMs: z.number().int().positive(),
});
export type ApprovalServiceEnvSettings = z.infer<typeof ApprovalServiceEnvSettingsSchema>;

export function loadApprovalServiceSettingsFromEnv(env: NodeJS.ProcessEnv): ApprovalServiceEnvSettings {
  const candidate = {
    executionLeaseMs: Number(env.APPROVAL_EXECUTION_LEASE_MS ?? 60_000),
    autoExecuteTimeoutMs: Number(env.AUTO_EXECUTE_TIMEOUT_MS ?? 15_000),
  };
  const result = ApprovalServiceEnvSettingsSchema.safeParse(candidate);
  if (!result.success) {
    throw new Error(`Invalid ApprovalServiceEnvSettings: ${result.error.message}`);
  }
  return result.data;
}
