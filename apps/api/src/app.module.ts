import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { HealthController } from './common/health/health.controller';
import { HealthService } from './common/health/health.service';
import { ToolRunnerModule } from './agent/tool-runner/tool-runner.module';
import { DatabaseModule } from './db/database.module';
import { AuthModule } from './auth/auth.module';
import { LlmModule } from './llm/llm.module';
import { IngestionModule } from './ingestion/ingestion.module';
import { RetrievalModule } from './retrieval/retrieval.module';

/**
 * DatabaseModule itself is only imported when MONGODB_URI is actually set -
 * it crashes immediately otherwise (MongooseModule.forRoot with no URI).
 * AuthModule, IngestionModule, and RetrievalModule are ALWAYS imported,
 * regardless: each is internally safe to import with no database at all
 * (their DB-dependent pieces are @Optional() and fail with a clear 503,
 * never a crash or a silently-missing route) - see auth.module.ts,
 * ingestion.module.ts, and retrieval.module.ts.
 */
const databaseImports = process.env.MONGODB_URI ? [DatabaseModule] : [];

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    ToolRunnerModule,
    LlmModule,
    AuthModule,
    IngestionModule,
    RetrievalModule,
    ...databaseImports,
  ],
  controllers: [HealthController],
  providers: [HealthService],
})
export class AppModule {}
