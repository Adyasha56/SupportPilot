import { Provider } from '@nestjs/common';
import { RunAgentSettings } from '../agent/loop/run-agent';
import { loadRunAgentDeadlineSettingsFromEnv } from '../agent/loop/run-agent.settings';
import { LLM_SETTINGS } from '../llm/llm-settings.provider';
import { LlmSettings } from '../llm/llm.settings';

export const RUN_AGENT_SETTINGS = Symbol('RUN_AGENT_SETTINGS');

/**
 * RunAgentSettings is assembled from two independently-loaded settings
 * objects, not its own env loader - the deadline/retry knobs
 * (run-agent.settings.ts) and the generate() call shape (generateMaxOutputTokens/
 * generateTemperature/generateThinkingLevel, llm.settings.ts) are each
 * already validated and env-driven in their own right; this just combines
 * them into the one shape runAgent's own RunAgentDeps.settings expects,
 * rather than inventing a third parallel settings loader that could drift
 * from either source.
 */
export const runAgentSettingsProvider: Provider = {
  provide: RUN_AGENT_SETTINGS,
  inject: [LLM_SETTINGS],
  useFactory: (llmSettings: LlmSettings): RunAgentSettings => {
    const deadline = loadRunAgentDeadlineSettingsFromEnv(process.env);
    return {
      perLlmCallTimeoutMs: deadline.perCallTimeoutMs,
      totalDeadlineMs: deadline.totalDeadlineMs,
      retrievalTimeoutMs: deadline.retrievalTimeoutMs,
      timeoutMaxRetries: deadline.timeoutMaxRetries,
      generateMaxOutputTokens: llmSettings.generateMaxOutputTokens,
      generateTemperature: llmSettings.generateTemperature,
      ...(llmSettings.generateThinkingLevel ? { generateThinkingLevel: llmSettings.generateThinkingLevel } : {}),
    };
  },
};
