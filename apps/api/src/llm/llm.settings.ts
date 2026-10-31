import { z } from 'zod';

export const LlmSettingsSchema = z.object({
  /**
   * Optional by design: a missing key must not block the app from booting
   * (see GeminiLlmProvider.embed's NOT_CONFIGURED outcome). Every other
   * setting below has a usable default even with no key at all.
   */
  geminiApiKey: z.string().min(1).optional(),
  /**
   * Conservative default, not a verified Gemini free-tier number - per
   * RULES.md section 7, free-tier limits change and must be checked in AI
   * Studio, not assumed. Override with GEMINI_EMBED_RPM once verified.
   */
  requestsPerMinute: z.number().int().positive(),
  maxConcurrency: z.number().int().positive(),
  maxRetries: z.number().int().nonnegative(),
  requestTimeoutMs: z.number().int().positive(),
  /**
   * Our own guardrail, not an SDK- or docs-stated hard limit - the Gemini
   * Developer API (as opposed to Vertex AI) imposes no documented batch-size
   * cap on embedContent, so this exists only to bound the blast radius of
   * one call (cost, latency, retry cost) rather than to satisfy a real limit.
   */
  maxTextsPerBatch: z.number().int().positive(),
  /**
   * Gemini's documented per-text input limit is 2048 tokens, not
   * characters - this is a conservative character-based approximation
   * (no tokenizer is wired up), deliberately smaller than a true
   * token-accurate cap would allow.
   */
  maxCharsPerText: z.number().int().positive(),
  cacheMaxEntries: z.number().int().positive(),
  /**
   * Google's own current recommendation for new projects (ai.google.dev/gemini-api/docs/models,
   * checked live 2026-10-31) - cheapest/fastest GA tier, and critically never
   * needs native function calling + structured output together (that
   * combination is gated to Gemini-3-series preview only), so this model is
   * never at risk of silently losing structured-output support.
   */
  generateModel: z.string().min(1),
  /** Same honest caveat as requestsPerMinute above - a conservative default, verify the real number in AI Studio. Override with GEMINI_GENERATE_RPM. */
  generateRequestsPerMinute: z.number().int().positive(),
  generateMaxConcurrency: z.number().int().positive(),
  generateMaxRetries: z.number().int().nonnegative(),
  /** 20s per call, per PROJECT.md's Milestone 3 agent loop design (amendment H) - a plan or compose call that hasn't returned by then is abandoned, not awaited indefinitely. */
  generateTimeoutMs: z.number().int().positive(),
  /** Planner/compose outputs are short structured JSON, not prose - bounded well below a full response to cap cost and latency per call. */
  generateMaxOutputTokens: z.number().int().positive(),
  /** Non-zero by default for normal traffic; the agent loop overrides this to 0 in deterministic/eval mode (PROJECT.md's Milestone 6 note - not a byte-identical guarantee, only a variance reducer). */
  generateTemperature: z.number().nonnegative(),
});
export type LlmSettings = z.infer<typeof LlmSettingsSchema>;

export function loadLlmSettingsFromEnv(env: NodeJS.ProcessEnv): LlmSettings {
  const candidate = {
    geminiApiKey: env.GEMINI_API_KEY || undefined,
    requestsPerMinute: Number(env.GEMINI_EMBED_RPM ?? 10),
    maxConcurrency: Number(env.GEMINI_EMBED_MAX_CONCURRENCY ?? 2),
    maxRetries: Number(env.GEMINI_EMBED_MAX_RETRIES ?? 5),
    requestTimeoutMs: Number(env.GEMINI_EMBED_TIMEOUT_MS ?? 10_000),
    maxTextsPerBatch: Number(env.GEMINI_EMBED_MAX_BATCH ?? 32),
    maxCharsPerText: Number(env.GEMINI_EMBED_MAX_CHARS_PER_TEXT ?? 8000),
    cacheMaxEntries: Number(env.GEMINI_EMBED_CACHE_MAX_ENTRIES ?? 500),
    generateModel: env.GEMINI_GENERATE_MODEL || 'gemini-3.5-flash-lite',
    generateRequestsPerMinute: Number(env.GEMINI_GENERATE_RPM ?? 10),
    generateMaxConcurrency: Number(env.GEMINI_GENERATE_MAX_CONCURRENCY ?? 2),
    generateMaxRetries: Number(env.GEMINI_GENERATE_MAX_RETRIES ?? 5),
    generateTimeoutMs: Number(env.GEMINI_GENERATE_TIMEOUT_MS ?? 20_000),
    generateMaxOutputTokens: Number(env.GEMINI_GENERATE_MAX_OUTPUT_TOKENS ?? 1024),
    generateTemperature: Number(env.GEMINI_GENERATE_TEMPERATURE ?? 0.2),
  };

  const result = LlmSettingsSchema.safeParse(candidate);
  if (!result.success) {
    throw new Error(`Invalid LlmSettings: ${result.error.message}`);
  }
  return result.data;
}
