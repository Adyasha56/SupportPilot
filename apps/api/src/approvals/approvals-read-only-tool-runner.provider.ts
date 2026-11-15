import { Logger, Provider } from '@nestjs/common';
import { ConnectorConfigRepository } from '../connectors/connector-config.repository';
import { CONNECTOR_CONFIG_REPOSITORY } from '../connectors/connector-config-repository.provider';
import { ReadOnlyToolRunner } from '../agent/loop/read-only-tool-runner';
import { TOOL_RUNNER_SETTINGS } from '../agent/tool-runner/tool-runner-settings.provider';
import { ToolRunnerSettings } from '../agent/tool-runner/tool-runner.settings';

export const APPROVALS_READ_ONLY_TOOL_RUNNER = Symbol('APPROVALS_READ_ONLY_TOOL_RUNNER');

const logger = new Logger('ApprovalsToolRunner');

/**
 * Stage 6, item 2 - the admin decision route's own fresh-order fetch (ApproveFromPending's
 * decision-time verifier re-check, amendment A) goes through the SAME risk-gated
 * `ReadOnlyToolRunner` the chat path already uses (chat/read-only-tool-runner.provider.ts),
 * never the generic `ToolRunnerService`/`runTool` directly - `get_order` is the only tool this
 * ever calls, and the SAME defense-in-depth riskLevel gate applies regardless of which module
 * happens to be calling it.
 */
export const approvalsReadOnlyToolRunnerProvider: Provider = {
  provide: APPROVALS_READ_ONLY_TOOL_RUNNER,
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
