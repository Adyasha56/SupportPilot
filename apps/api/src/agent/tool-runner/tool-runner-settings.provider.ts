import { Provider } from '@nestjs/common';
import { loadToolRunnerSettingsFromEnv } from './tool-runner.settings';

export const TOOL_RUNNER_SETTINGS = Symbol('TOOL_RUNNER_SETTINGS');

/**
 * useFactory runs during Nest's DI container initialization, so an invalid
 * env fails application bootstrap immediately rather than failing later on
 * the first tool call.
 */
export const toolRunnerSettingsProvider: Provider = {
  provide: TOOL_RUNNER_SETTINGS,
  useFactory: () => loadToolRunnerSettingsFromEnv(process.env),
};
