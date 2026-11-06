import { describe, expect, it } from 'vitest';
import { ActiveKeyLimitExceededError, DuplicateKidError } from '../customer-public-key.repository';
import { InMemoryCustomerPublicKeyRepository } from './in-memory-customer-public-key.repository';

describe('InMemoryCustomerPublicKeyRepository', () => {
  it('registers a key as active and makes it findable by (tenantId, kid)', async () => {
    const repo = new InMemoryCustomerPublicKeyRepository();
    await repo.register('acme', 1, 'pubkey-x-value', 5);

    expect(await repo.findActive('acme', 1)).toBe('pubkey-x-value');
  });

  it('findActive is scoped by tenantId - the same kid for another tenant never matches', async () => {
    const repo = new InMemoryCustomerPublicKeyRepository();
    await repo.register('acme', 1, 'acme-key', 5);

    expect(await repo.findActive('widgetco', 1)).toBeUndefined();
  });

  it('refuses a duplicate (tenantId, kid)', async () => {
    const repo = new InMemoryCustomerPublicKeyRepository();
    await repo.register('acme', 1, 'first-key', 5);

    await expect(repo.register('acme', 1, 'second-key', 5)).rejects.toThrow(DuplicateKidError);
  });

  it('enforces the max-active-keys-per-tenant cap', async () => {
    const repo = new InMemoryCustomerPublicKeyRepository();
    await repo.register('acme', 1, 'key1', 2);
    await repo.register('acme', 2, 'key2', 2);

    await expect(repo.register('acme', 3, 'key3', 2)).rejects.toThrow(ActiveKeyLimitExceededError);
  });

  it('a retired key is no longer findable via findActive - behaves exactly like an unknown kid', async () => {
    const repo = new InMemoryCustomerPublicKeyRepository();
    await repo.register('acme', 1, 'first-key', 5);

    expect(await repo.retire('acme', 1)).toBe(true);
    expect(await repo.findActive('acme', 1)).toBeUndefined();
  });

  it('retiring a key frees up a slot under the active-key cap', async () => {
    const repo = new InMemoryCustomerPublicKeyRepository();
    await repo.register('acme', 1, 'key1', 1);
    await expect(repo.register('acme', 2, 'key2', 1)).rejects.toThrow(ActiveKeyLimitExceededError);

    await repo.retire('acme', 1);
    await expect(repo.register('acme', 2, 'key2', 1)).resolves.toMatchObject({ kid: 2 });
  });

  it('retire returns false for an unknown or already-retired kid, scoped by tenant', async () => {
    const repo = new InMemoryCustomerPublicKeyRepository();
    await repo.register('acme', 1, 'key1', 5);

    expect(await repo.retire('widgetco', 1)).toBe(false);
    expect(await repo.retire('acme', 999)).toBe(false);
    expect(await repo.retire('acme', 1)).toBe(true);
    expect(await repo.retire('acme', 1)).toBe(false); // already retired
  });

  it('deleteForTenant only removes that tenant\'s keys', async () => {
    const repo = new InMemoryCustomerPublicKeyRepository();
    await repo.register('acme', 1, 'acme-key', 5);
    await repo.register('widgetco', 1, 'widgetco-key', 5);

    await repo.deleteForTenant('acme');

    expect(await repo.findActive('acme', 1)).toBeUndefined();
    expect(await repo.findActive('widgetco', 1)).toBe('widgetco-key');
  });
});
