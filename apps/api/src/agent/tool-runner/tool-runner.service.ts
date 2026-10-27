import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConnectorConfigRepository } from '../../connectors/connector-config.repository';
import { CONNECTOR_CONFIG_REPOSITORY } from '../../connectors/connector-config-repository.provider';
import { runTool, ToolRunResult } from './tool-runner';
import { TOOL_RUNNER_SETTINGS } from './tool-runner-settings.provider';
import { ToolRunnerSettings } from './tool-runner.settings';

@Injectable()
export class ToolRunnerService {
  private readonly logger = new Logger(ToolRunnerService.name);

  constructor(
    @Inject(CONNECTOR_CONFIG_REPOSITORY) private readonly repository: ConnectorConfigRepository,
    @Inject(TOOL_RUNNER_SETTINGS) private readonly settings: ToolRunnerSettings,
  ) {}

  run(tenantId: string, toolName: string, args: Record<string, unknown>): Promise<ToolRunResult> {
    return runTool({
      tenantId,
      toolName,
      args,
      repository: this.repository,
      settings: this.settings,
      logOutcome: (t, tool, code, durationMs) => {
        this.logger.log(`tenantId=${t} tool=${tool} outcome=${code} durationMs=${durationMs}`);
      },
    });
  }
}
