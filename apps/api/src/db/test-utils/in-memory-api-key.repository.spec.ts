import { describe, expect, it } from 'vitest';
import { InMemoryApiKeyRepository } from './in-memory-api-key.repository';

describe('InMemoryApiKeyRepository', () => {
  it('returns null for an unknown hash', async () => {
    const repo = new InMemoryApiKeyRepository();
    expect(await repo.findByHash('nope')).toBeNull();
  });

  it('finds a created key by its hash', async () => {
    const repo = new InMemoryApiKeyRepository();
    const id = await repo.create('acme', 'hash-abc', 'sk_abcd12', ['secret']);

    const found = await repo.findByHash('hash-abc');
    expect(found).toEqual({ id, tenantId: 'acme', scopes: ['secret'], revokedAt: null, hash: 'hash-abc' });
  });

  it('revoke marks the key revoked and is idempotent (second call returns false)', async () => {
    const repo = new InMemoryApiKeyRepository();
    const id = await repo.create('acme', 'hash-abc', 'sk_abcd12', ['secret']);

    expect(await repo.revoke(id)).toBe(true);
    expect((await repo.findByHash('hash-abc'))?.revokedAt).toBeInstanceOf(Date);
    expect(await repo.revoke(id)).toBe(false);
  });

  it('revoke on an unknown id returns false', async () => {
    const repo = new InMemoryApiKeyRepository();
    expect(await repo.revoke('nonexistent')).toBe(false);
  });
});
