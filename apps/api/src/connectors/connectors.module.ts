import { Module } from '@nestjs/common';
import { AdminAuthModule } from '../admin-auth/admin-auth.module';
import { connectorConfigRepositoryProvider, connectorConfigSettingsProvider } from './connector-config-repository.provider';
import { ConnectorsAdminController } from './connectors-admin.controller';

/**
 * Stage 1c, item 4 - `AdminAuthModule` is imported here (not by a new
 * sibling module) specifically so the read-only `GET /v1/connectors`
 * route lives right next to the repository it reads, the same reasoning
 * ApprovalsController/ApprovalsModule already follow. This module is
 * already imported transitively into AppModule's graph (via ChatModule,
 * ApprovalsModule), so `ConnectorsAdminController` is active with no
 * further AppModule change needed.
 */
@Module({
  imports: [AdminAuthModule],
  controllers: [ConnectorsAdminController],
  providers: [connectorConfigSettingsProvider, connectorConfigRepositoryProvider],
  exports: [connectorConfigRepositoryProvider, connectorConfigSettingsProvider],
})
export class ConnectorsModule {}
