import { Module } from '@nestjs/common';
import { connectorConfigRepositoryProvider, connectorConfigSettingsProvider } from './connector-config-repository.provider';

/**
 * Deliberately NO admin controller and NO `AdminAuthModule` import here -
 * this module is reached only TRANSITIVELY (via ToolRunnerModule,
 * ChatModule, ApprovalsModule), never listed directly in AppModule's own
 * `imports`. A real CI run against Atlas Local (2026-11-23) proved that
 * bolting `ConnectorsAdminController`/`AdminAuthModule` onto THIS module
 * does not reliably wire `AdminAuthGuard`'s database-backed dependencies
 * in the full app graph - a real admin API key and a real session both
 * got a false 401 on `GET /v1/connectors`, even though the identical
 * `@UseGuards(AdminAuthGuard)` pattern works correctly on every OTHER
 * admin route. The admin-facing controller now lives in its own
 * `ConnectorsAdminModule` (connectors-admin.module.ts), imported directly
 * at the AppModule root - the exact same shape as `ConversationsAdminModule`/
 * `TenantSettingsAdminModule`, which are proven to work. See
 * docs/known-limitations.md for the fuller account.
 */
@Module({
  providers: [connectorConfigSettingsProvider, connectorConfigRepositoryProvider],
  exports: [connectorConfigRepositoryProvider, connectorConfigSettingsProvider],
})
export class ConnectorsModule {}
