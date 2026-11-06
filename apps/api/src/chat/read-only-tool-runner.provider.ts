import { Logger, Provider } from '@nestjs/common';
import { ConnectorConfigRepository } from '../connectors/connector-config.repository';
import { CONNECTOR_CONFIG_REPOSITORY } from '../connectors/connector-config-repository.provider';
import { ReadOnlyToolRunner } from '../agent/loop/read-only-tool-runner';
import { TOOL_RUNNER_SETTINGS } from '../agent/tool-runner/tool-runner-settings.provider';
import { ToolRunnerSettings } from '../agent/tool-runner/tool-runner.settings';

export const READ_ONLY_TOOL_RUNNER = Symbol('READ_ONLY_TOOL_RUNNER');

const logger = new Logger('ChatToolRunner');

/**
 * PROJECT.md's Agent loop design: ReadOnlyToolRunner, not ToolRunnerService,
 * is what runAgent's RunAgentDeps.toolRunner must be - ToolRunnerService
 * calls the real tool runner directly with no riskLevel gate at all, which
 * would let a scripted/compromised model reach issue_refund straight from
 * the agent loop. ReadOnlyToolRunner refuses anything whose connector
 * config riskLevel isn't "low", independently of the planner's own
 * allow-list (defense in depth, PROJECT.md's Milestone 3 agent design).
 */
export const readOnlyToolRunnerProvider: Provider = {
  provide: READ_ONLY_TOOL_RUNNER,
  inject: [CONNECTOR_CONFIG_REPOSITORY, TOOL_RUNNER_SETTINGS],
  useFactory: (repository: ConnectorConfigRepository, settings: ToolRunnerSettings) =>
    new ReadOnlyToolRunner({
      repository,
      settings,
      logOutcome: (tenantId, tool, code, durationMs) => {
        logger.log(`tenantId=${tenantId} tool=${tool} outcome=${code} durationMs=${durationMs}`);
      },
    }),
};
