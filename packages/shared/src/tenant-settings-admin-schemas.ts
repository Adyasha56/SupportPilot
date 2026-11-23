import { z } from 'zod';

/**
 * Milestone 5, Stage 1c, item 3 - `GET`/`PUT /v1/tenant/settings`. Never
 * includes a secret of any kind - Tenant's own settings (refundCap,
 * approvalThreshold, refundWindowDays, autoExecuteRefunds,
 * approvalExpiryDays, dailyRefundCountLimit) are operational numbers/flags,
 * not credentials.
 */
export const TenantSettingsResponseSchema = z.object({
  tenantId: z.string(),
  refundCap: z.number(),
  approvalThreshold: z.number(),
  refundWindowDays: z.number(),
  autoExecuteRefunds: z.boolean(),
  approvalExpiryDays: z.number(),
  dailyRefundCountLimit: z.number().optional(),
});
export type TenantSettingsResponse = z.infer<typeof TenantSettingsResponseSchema>;

/**
 * Every settings field is independently optional - only the ones present
 * are changed (`TenantRepository.updateSettings`'s own existing contract,
 * unchanged by this stage). `confirmAutoExecute` mirrors
 * `set-tenant-settings.ts`'s own `--confirmAutoExecute` CLI flag - required
 * `true` whenever `autoExecuteRefunds: true` is part of THIS call, the
 * same plain CLI-level friction now expressed as a request field.
 * `password` is the STEP-UP re-entry (PROJECT.md's Milestone 5 handoff
 * section 3) - required only when this same call would enable
 * `autoExecuteRefunds` or raise `refundCap`, and only ever checked for a
 * session principal (an admin API key is refused before `password` is
 * even looked at - see the controller's own doc comment).
 */
export const TenantSettingsPatchRequestSchema = z.object({
  refundCap: z.number().nonnegative().optional(),
  approvalThreshold: z.number().nonnegative().optional(),
  refundWindowDays: z.number().int().positive().optional(),
  autoExecuteRefunds: z.boolean().optional(),
  approvalExpiryDays: z.number().int().positive().optional(),
  dailyRefundCountLimit: z.number().int().positive().optional(),
  confirmAutoExecute: z.boolean().optional(),
  password: z.string().max(1000).optional(),
});
export type TenantSettingsPatchRequest = z.infer<typeof TenantSettingsPatchRequestSchema>;
