import { Module } from '@nestjs/common';
import { AdminAuthModule } from '../admin-auth/admin-auth.module';
import { DatabaseModule } from '../db/database.module';
import { ConversationsAdminController } from './conversations-admin.controller';
import { ConversationsAdminService } from './conversations-admin.service';

/**
 * Stage 1c, item 2. Same self-sufficient, always-importable-with-no-database
 * pattern as every other domain module (ingestion.module.ts, approvals.module.ts) -
 * `ConversationsAdminService`'s repositories are all `@Optional()`, so
 * every route here exists and returns a real 503, never a crash or a
 * silently-missing route, when `MONGODB_URI` is unset.
 */
export function conversationsAdminDatabaseImportsFor(env: NodeJS.ProcessEnv): [typeof DatabaseModule] | [] {
  return env.MONGODB_URI ? [DatabaseModule] : [];
}

@Module({
  imports: [AdminAuthModule, ...conversationsAdminDatabaseImportsFor(process.env)],
  controllers: [ConversationsAdminController],
  providers: [ConversationsAdminService],
})
export class ConversationsAdminModule {}
