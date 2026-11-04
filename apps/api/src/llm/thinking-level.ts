/**
 * Per-model supported thinking levels - ai.google.dev/gemini-api/docs/thinking
 * (redirects to aistudio.google.com/docs/thinking; checked live 2026-11-03).
 * Stage 4 finding 1: switching GEMINI_GENERATE_MODEL to gemini-3.8-flash
 * while GEMINI_THINKING_LEVEL was left at "minimal" caused every real call
 * to fail with INVALID_INPUT (a 400 from the API) - gemini-3.8-flash does
 * not support "minimal" at all, only low/medium/high. This table exists so
 * that exact mistake fails loudly at startup, not silently at runtime
 * against the real API.
 *
 * A model NOT in this table is UNKNOWN to us - validation is skipped for
 * it (see validateThinkingLevel's own doc comment), never assumed either
 * compatible or incompatible. Keep this in sync by re-checking the source
 * URL whenever a new model is adopted; do not extend it from memory.
 */
const SUPPORTED_THINKING_LEVELS: Readonly<Record<string, ReadonlySet<string>>> = {
  'gemini-4-argon': new Set(['low', 'medium', 'high']),
  'gemini-3.8-flash': new Set(['low', 'medium', 'high']),
  'gemini-3.6-flash': new Set(['minimal', 'low', 'medium', 'high']),
  'gemini-3.5-flash-lite': new Set(['minimal', 'low', 'medium', 'high']),
  'gemini-3.1-pro-preview': new Set(['low', 'medium', 'high']),
  'gemini-3.1-flash-lite-image': new Set(['minimal', 'high']),
  'gemini-3-flash-preview': new Set(['minimal', 'low', 'medium', 'high']),
  'gemini-3-pro-preview': new Set(['low', 'high']),
  'gemini-2.5-pro': new Set(['low', 'medium', 'high']),
  'gemini-2.5-flash': new Set(['low', 'medium', 'high']),
  'gemini-2.5-flash-lite': new Set(['low', 'medium', 'high']),
  'gemini-robotics-er-2-preview': new Set(['minimal', 'low', 'medium', 'high']),
};

export class UnsupportedThinkingLevelError extends Error {
  constructor(model: string, level: string, supported: readonly string[]) {
    super(
      `GEMINI_THINKING_LEVEL="${level}" is not supported by GEMINI_GENERATE_MODEL="${model}". ` +
        `Supported levels for this model: ${supported.join(', ')}. ` +
        `Source: ai.google.dev/gemini-api/docs/thinking (checked 2026-11-03) - re-verify live if this model's own support has since changed.`,
    );
    this.name = 'UnsupportedThinkingLevelError';
  }
}

/**
 * Throws at startup (synchronously, from loadLlmSettingsFromEnv) rather
 * than letting an incompatible combination reach the real API as a
 * runtime INVALID_INPUT - the whole point of Stage 4 finding 1. `level`
 * undefined means "not explicitly configured" and is always valid (see
 * llm.settings.ts's own doc comment: never send a thinking level unless
 * the operator explicitly asked for one).
 */
export function validateThinkingLevel(model: string, level: 'minimal' | 'low' | 'medium' | 'high' | undefined): void {
  if (level === undefined) {
    return;
  }
  const supported = SUPPORTED_THINKING_LEVELS[model];
  if (supported === undefined) {
    // Unknown model - we cannot validate either way. Never silently assume compatible.
    return;
  }
  if (!supported.has(level)) {
    throw new UnsupportedThinkingLevelError(model, level, [...supported]);
  }
}

/** For script headers: "default" when nothing was explicitly configured, never the literal string "undefined". */
export function formatThinkingLevel(level: 'minimal' | 'low' | 'medium' | 'high' | undefined): string {
  return level ?? 'default';
}
