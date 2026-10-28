import { Module } from '@nestjs/common';
import { llmSettingsProvider, LLM_SETTINGS } from './llm-settings.provider';
import { GeminiLlmProvider } from './gemini-llm-provider';

export const LLM_PROVIDER = Symbol('LLM_PROVIDER');
export { LLM_SETTINGS };

/**
 * Always importable, with or without GEMINI_API_KEY set - unlike
 * DatabaseModule/AuthModule, this module itself never fails to boot; only a
 * call to embed() without a key returns the NOT_CONFIGURED outcome.
 *
 * LLM_SETTINGS is exported too (not just LLM_PROVIDER) so callers that need
 * to know UPFRONT whether a key is configured - e.g. the ingestion
 * controller, to return a 503 before doing any chunking/DB work at all -
 * can check settings.geminiApiKey directly instead of paying for a wasted
 * embed() call just to discover it's not configured.
 */
@Module({
  providers: [llmSettingsProvider, { provide: LLM_PROVIDER, useClass: GeminiLlmProvider }],
  exports: [LLM_PROVIDER, LLM_SETTINGS],
})
export class LlmModule {}
