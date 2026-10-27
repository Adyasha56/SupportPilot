import { join } from 'node:path';
import { Provider } from '@nestjs/common';
import { FileConnectorConfigRepository } from './connector-config.repository';

export const CONNECTOR_CONFIG_REPOSITORY = Symbol('CONNECTOR_CONFIG_REPOSITORY');

/**
 * Defaults to a path relative to process.cwd(), which is the package root
 * both in local dev ("node dist/main.js" run from apps/api/) and in the
 * Docker runtime image (WORKDIR /app, matching where apps/api's "files"
 * field deploys src/connectors/fixtures alongside dist/). Overridable via
 * env for flexibility.
 */
export const connectorConfigRepositoryProvider: Provider = {
  provide: CONNECTOR_CONFIG_REPOSITORY,
  useFactory: () => {
    const fixturesRoot =
      process.env.CONNECTOR_FIXTURES_DIR ?? join(process.cwd(), 'src/connectors/fixtures');
    return new FileConnectorConfigRepository(fixturesRoot);
  },
};
