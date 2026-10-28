import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { LlmModule } from '../llm/llm.module';
import { ingestionSettingsProvider } from './ingestion-settings.provider';
import { MulterExceptionFilter } from './multer-exception.filter';
import { PoliciesController } from './policies.controller';
import { PolicyIngestionService } from './policy-ingestion.service';
import { StalePendingCleanupService } from './stale-pending-cleanup.service';
import { TenantIngestionLock } from './tenant-ingestion-lock';

/**
 * Always imported into AppModule, REGARDLESS of whether MONGODB_URI is set
 * - unlike DatabaseModule itself. The /v1/policies routes must exist and
 * return a proper 503 when the database or LLM provider isn't configured,
 * not a bare 404 from the route never having been registered at all. The
 * repository tokens this module's controller/services depend on are
 * @Optional() for exactly this reason - see policy-ingestion.service.ts
 * and stale-pending-cleanup.service.ts.
 */
@Module({
  imports: [AuthModule, LlmModule],
  controllers: [PoliciesController],
  providers: [
    ingestionSettingsProvider,
    PolicyIngestionService,
    StalePendingCleanupService,
    TenantIngestionLock,
    MulterExceptionFilter,
  ],
})
export class IngestionModule {}
