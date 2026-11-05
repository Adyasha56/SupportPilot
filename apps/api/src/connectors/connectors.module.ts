import { Module } from '@nestjs/common';
import { connectorConfigRepositoryProvider, connectorConfigSettingsProvider } from './connector-config-repository.provider';

@Module({
  providers: [connectorConfigSettingsProvider, connectorConfigRepositoryProvider],
  exports: [connectorConfigRepositoryProvider, connectorConfigSettingsProvider],
})
export class ConnectorsModule {}
