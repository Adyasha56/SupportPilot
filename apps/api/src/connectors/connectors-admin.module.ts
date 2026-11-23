import { Module } from '@nestjs/common';
import { AdminAuthModule } from '../admin-auth/admin-auth.module';
import { ConnectorsModule } from './connectors.module';
import { ConnectorsAdminController } from './connectors-admin.controller';

/**
 * Stage 1c, item 4 (revised after a real CI failure, 2026-11-23) - the
 * admin-facing `GET /v1/connectors` route gets its OWN small module,
 * imported directly at the AppModule root, instead of living inside
 * `ConnectorsModule` itself (which is only ever reached transitively, via
 * ToolRunnerModule/ChatModule/ApprovalsModule, for the agent loop's own
 * tool-execution needs - a different consumer with different auth
 * requirements entirely). This is the exact same shape as
 * `ConversationsAdminModule`/`TenantSettingsAdminModule`, both of which
 * are proven to resolve `AdminAuthGuard`'s dependencies correctly in the
 * real app graph. `ConnectorsModule` is imported here only for its
 * already-exported `CONNECTOR_CONFIG_REPOSITORY` token.
 */
@Module({
  imports: [AdminAuthModule, ConnectorsModule],
  controllers: [ConnectorsAdminController],
})
export class ConnectorsAdminModule {}
