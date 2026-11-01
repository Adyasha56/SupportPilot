import { describe, expect, it } from 'vitest';
import { FileConnectorConfigRepository } from './connector-config.repository';
import { connectorConfigRepositoryProvider } from './connector-config-repository.provider';

function buildRepository(connectorConfigDir: string | undefined) {
  const factory = connectorConfigRepositoryProvider as { useFactory: (settings: { connectorConfigDir?: string }) => unknown };
  return factory.useFactory({ connectorConfigDir });
}

describe('connectorConfigRepositoryProvider', () => {
  it('wires a DisabledConnectorConfigRepository when connectorConfigDir is unset', () => {
    const repository = buildRepository(undefined) as { constructor: { name: string } };
    expect(repository.constructor.name).toBe('DisabledConnectorConfigRepository');
  });

  it('wires a real FileConnectorConfigRepository when connectorConfigDir is set', () => {
    const repository = buildRepository('/some/path');
    expect(repository).toBeInstanceOf(FileConnectorConfigRepository);
  });
});
