import { Module } from '@nestjs/common';
import { ConnectorsModule } from '../../connectors/connectors.module';
import { toolRunnerSettingsProvider } from './tool-runner-settings.provider';
import { ToolRunnerService } from './tool-runner.service';

@Module({
  imports: [ConnectorsModule],
  providers: [toolRunnerSettingsProvider, ToolRunnerService],
  exports: [toolRunnerSettingsProvider, ToolRunnerService],
})
export class ToolRunnerModule {}
