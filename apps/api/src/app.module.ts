import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { HealthController } from './common/health/health.controller';
import { HealthService } from './common/health/health.service';
import { ToolRunnerModule } from './agent/tool-runner/tool-runner.module';

@Module({
  imports: [ConfigModule.forRoot({ isGlobal: true }), ToolRunnerModule],
  controllers: [HealthController],
  providers: [HealthService],
})
export class AppModule {}
