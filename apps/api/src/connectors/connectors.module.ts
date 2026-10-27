import { Module } from '@nestjs/common';
import { connectorConfigRepositoryProvider } from './connector-config-repository.provider';

@Module({
  providers: [connectorConfigRepositoryProvider],
  exports: [connectorConfigRepositoryProvider],
})
export class ConnectorsModule {}
