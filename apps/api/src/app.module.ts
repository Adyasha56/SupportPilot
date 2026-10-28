import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { HealthController } from './common/health/health.controller';
import { HealthService } from './common/health/health.service';
import { ToolRunnerModule } from './agent/tool-runner/tool-runner.module';
import { DatabaseModule } from './db/database.module';
import { AuthModule } from './auth/auth.module';
import { LlmModule } from './llm/llm.module';

/**
 * DatabaseModule (and everything built on it: auth, ingestion, retrieval, in
 * later stages) is only imported when MONGODB_URI is actually set. This
 * keeps the app booting and /health passing with no database configured at
 * all - the same pattern Milestone 1 used for ToolRunnerSettings.
 */
const databaseImports = process.env.MONGODB_URI ? [DatabaseModule, AuthModule] : [];

@Module({
  imports: [ConfigModule.forRoot({ isGlobal: true }), ToolRunnerModule, LlmModule, ...databaseImports],
  controllers: [HealthController],
  providers: [HealthService],
})
export class AppModule {}
