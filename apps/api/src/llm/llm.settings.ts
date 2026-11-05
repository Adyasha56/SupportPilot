import { z } from 'zod';
import { validateThinkingLevel } from './thinking-level';

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
  /** 10s per call (lowered from 20s on 2026-11-02, Stage 4 finding 8/B) - a plan or compose call that hasn't returned by then is abandoned, not awaited indefinitely. */
  generateTimeoutMs: z.number().int().positive(),
  /** Planner/compose outputs are short structured JSON, not prose - bounded well below a full response to cap cost and latency per call. */
  generateMaxOutputTokens: z.number().int().positive(),
  /** Non-zero by default for normal traffic; the agent loop overrides this to 0 in deterministic/eval mode (PROJECT.md's Milestone 6 note - not a byte-identical guarantee, only a variance reducer). */
  generateTemperature: z.number().nonnegative(),
  /**
   * Stage 4 finding 1 (revised from finding C) - UNSET by default,
   * deliberately: never send a thinking level to the API unless the
   * operator explicitly configured one. A real run showed why forcing a
   * project-wide default is unsafe - "minimal" (chosen because it's
   * gemini-3.5-flash-lite's own default) caused every real call to fail
   * with INVALID_INPUT the moment the model was switched to
   * gemini-3.8-flash, which doesn't support "minimal" at all. When unset,
   * the model's own default behavior applies, whatever that is for
   * whichever model is configured - this setting exists only for an
   * operator who has a specific, deliberate reason to override that.
   * Validated against the configured model at startup in
   * loadLlmSettingsFromEnv (thinking-level.ts) - an incompatible
   * combination fails loudly here, never silently at the real API.
   */
  generateThinkingLevel: z.enum(['minimal', 'low', 'medium', 'high']).optional(),
  /**
   * Global, in-memory, single-process cap on real generate() calls per
   * rolling day - see apps/api/src/agent/loop/daily-generate-budget.ts.
   * Default (300) is well under the real per-day cap this project's own
   * AI Studio project reported for the default model (500/day, recorded
   * docs/learning-notes.md, Stage 4 finding 7, checked 2026-11-02) -
   * never assume that number holds for a different project or a later
   * date (RULES.md section 7).
   */
  dailyGenerateBudget: z.number().int().positive(),
  /**
   * Stage 4 finding 3 - K, consecutive TIMEOUT/UNAVAILABLE outcomes before
   * generate()'s circuit breaker opens. See circuit-breaker.ts's own doc
   * comment for the full design and why only those two codes count.
   */
  circuitBreakerFailureThreshold: z.number().int().positive(),
  /** How long the breaker stays open before allowing one half-open trial call. */
  circuitBreakerCooldownMs: z.number().int().positive(),
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
    generateMaxRetries: Number(env.GEMINI_GENERATE_MAX_RETRIES ?? 2),
    generateTimeoutMs: Number(env.GEMINI_GENERATE_TIMEOUT_MS ?? 10_000),
    generateMaxOutputTokens: Number(env.GEMINI_GENERATE_MAX_OUTPUT_TOKENS ?? 1024),
    generateTemperature: Number(env.GEMINI_GENERATE_TEMPERATURE ?? 0.2),
    generateThinkingLevel: env.GEMINI_THINKING_LEVEL as 'minimal' | 'low' | 'medium' | 'high' | undefined,
    dailyGenerateBudget: Number(env.GEMINI_DAILY_GENERATE_BUDGET ?? 300),
    circuitBreakerFailureThreshold: Number(env.GEMINI_CIRCUIT_BREAKER_THRESHOLD ?? 3),
    circuitBreakerCooldownMs: Number(env.GEMINI_CIRCUIT_BREAKER_COOLDOWN_MS ?? 60_000),
  };

  const result = LlmSettingsSchema.safeParse(candidate);
  if (!result.success) {
    throw new Error(`Invalid LlmSettings: ${result.error.message}`);
  }
  // Stage 4 finding 1 - a model/level combination the API would reject
  // fails HERE, at startup, with a clear configuration error - never as a
  // runtime INVALID_INPUT discovered only when a real call is attempted.
  validateThinkingLevel(result.data.generateModel, result.data.generateThinkingLevel);
  return result.data;
}
