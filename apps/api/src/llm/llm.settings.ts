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
  };

  const result = LlmSettingsSchema.safeParse(candidate);
  if (!result.success) {
    throw new Error(`Invalid LlmSettings: ${result.error.message}`);
  }
  return result.data;
}
