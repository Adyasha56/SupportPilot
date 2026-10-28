import { Module } from '@nestjs/common';
import { llmSettingsProvider } from './llm-settings.provider';
import { GeminiLlmProvider } from './gemini-llm-provider';

export const LLM_PROVIDER = Symbol('LLM_PROVIDER');

/**
 * Always importable, with or without GEMINI_API_KEY set - unlike
 * DatabaseModule/AuthModule, this module itself never fails to boot; only a
 * call to embed() without a key returns the NOT_CONFIGURED outcome.
 */
@Module({
  providers: [llmSettingsProvider, { provide: LLM_PROVIDER, useClass: GeminiLlmProvider }],
  exports: [LLM_PROVIDER],
})
export class LlmModule {}
