import { z } from 'zod';

/**
 * The deadline/retry knobs runAgent itself owns (separate from
 * LlmSettings, which governs the throttled client's own RPM/concurrency/
 * backoff - these two settings objects are independent, same reasoning as
 * every other *Settings split in this project). Real run finding (Stage 4
 * finding B): a smoke script hardcoded perLlmCallTimeoutMs=20_000 even
 * though the developer's own .env said GEMINI_GENERATE_TIMEOUT_MS=10000 -
 * two different numbers, in two different places, meaning anyone's
 * .env change silently had no effect on the one place that actually
 * mattered for the agent loop. Validated and env-driven, like every other
 * settings loader here, so this can never happen again.
 */
export const RunAgentDeadlineSettingsSchema = z
  .object({
    /** Per generate() call attempt. Default 10s - matches this project's own .env default for GEMINI_GENERATE_TIMEOUT_MS, not a coincidence: both bound "how long is too long for one real call to Gemini." */
    perCallTimeoutMs: z.number().int().positive(),
    /** Total wall-clock budget for the whole run, across every step - never exceeded, even across TIMEOUT retries. */
    totalDeadlineMs: z.number().int().positive(),
    /** runAgent's own timeout around the retrieval call, further capped by the run's own remaining deadline at the call site (see run-agent.ts). */
    retrievalTimeoutMs: z.number().int().positive(),
    /** How many times a per-call TIMEOUT (not ABORTED) may be retried, bounded separately by the run's remaining deadline at each retry. Independent of GEMINI_GENERATE_MAX_RETRIES, which governs a different retry loop (rate-limit/5xx backoff inside ThrottledClient) - see llm-provider.interface.ts's GenerateErrorCode doc comment for why TIMEOUT and ABORTED are handled differently. */
    timeoutMaxRetries: z.number().int().nonnegative(),
  })
  .refine((value) => value.perCallTimeoutMs <= value.totalDeadlineMs, {
    message: 'perCallTimeoutMs must not exceed totalDeadlineMs',
    path: ['perCallTimeoutMs'],
  });
export type RunAgentDeadlineSettings = z.infer<typeof RunAgentDeadlineSettingsSchema>;

export function loadRunAgentDeadlineSettingsFromEnv(env: NodeJS.ProcessEnv): RunAgentDeadlineSettings {
  const candidate = {
    perCallTimeoutMs: Number(env.AGENT_PER_CALL_TIMEOUT_MS ?? 10_000),
    totalDeadlineMs: Number(env.AGENT_TOTAL_DEADLINE_MS ?? 30_000),
    retrievalTimeoutMs: Number(env.AGENT_RETRIEVAL_TIMEOUT_MS ?? 10_000),
    timeoutMaxRetries: Number(env.AGENT_TIMEOUT_MAX_RETRIES ?? 2),
  };
  const result = RunAgentDeadlineSettingsSchema.safeParse(candidate);
  if (!result.success) {
    throw new Error(`Invalid RunAgentDeadlineSettings: ${result.error.message}`);
  }
  return result.data;
}
