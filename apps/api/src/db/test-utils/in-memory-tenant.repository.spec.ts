import { describe, expect, it } from 'vitest';
import { InMemoryTenantRepository } from './in-memory-tenant.repository';

describe('InMemoryTenantRepository', () => {
  it('returns null for an unknown tenant', async () => {
    const repo = new InMemoryTenantRepository();
    expect(await repo.findById('acme')).toBeNull();
  });

  it('upsert creates a tenant, and is idempotent on repeat calls', async () => {
    const repo = new InMemoryTenantRepository();
    const first = await repo.upsert('acme', 'Acme Inc');
    const second = await repo.upsert('acme', 'A Different Name');

    expect(first).toEqual({ id: 'acme', name: 'Acme Inc' });
    // Second call does not overwrite - "creates if missing" only.
    expect(second).toEqual({ id: 'acme', name: 'Acme Inc' });
    expect(await repo.findById('acme')).toEqual({ id: 'acme', name: 'Acme Inc' });
  });
});
