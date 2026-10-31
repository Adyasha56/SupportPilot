import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { DatabaseModule } from '../db/database.module';
import { LlmModule } from '../llm/llm.module';
import { ingestionSettingsProvider } from './ingestion-settings.provider';
import { MulterExceptionFilter } from './multer-exception.filter';
import { PoliciesController } from './policies.controller';
import { PolicyIngestionService } from './policy-ingestion.service';
import { StalePendingCleanupService } from './stale-pending-cleanup.service';
import { TenantIngestionLock } from './tenant-ingestion-lock';

/**
 * Always imported into AppModule, REGARDLESS of whether MONGODB_URI is set
 * - unlike DatabaseModule itself, which crashes immediately with no URI.
 * DatabaseModule is only imported here when a URI is present (same
 * self-sufficient pattern as AuthModule - see auth.module.ts). Nest module
 * providers are NOT visible across sibling imports just because they share
 * a parent: IngestionModule must import DatabaseModule itself to see its
 * exported repository tokens, even though AppModule also imports both.
 * (This was missed initially - the repository tokens silently resolved to
 * undefined via @Optional() even with MONGODB_URI set, which the
 * controller-level tests never caught because they provide repositories
 * directly rather than exercising this real import graph. Caught by
 * running the real server against a real .env.)
 *
 * A plain, exported function - not an inline expression - specifically so
 * ingestion.module.spec.ts can call it directly with a fake env object and
 * assert on its return value, instead of needing a fresh dynamic
 * import()/vi.resetModules() cycle (which re-transforms and re-executes
 * this module's entire real dependency graph from scratch) just to see a
 * different env value take effect. Real decorator metadata (the exact
 * thing that was actually wrong in the original bug this test guards
 * against) is still read directly off the real DatabaseModule class by
 * both this function and the test - nothing here is faked.
 */
export function ingestionDatabaseImportsFor(env: NodeJS.ProcessEnv): [typeof DatabaseModule] | [] {
  return env.MONGODB_URI ? [DatabaseModule] : [];
}

@Module({
  imports: [AuthModule, LlmModule, ...ingestionDatabaseImportsFor(process.env)],
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
