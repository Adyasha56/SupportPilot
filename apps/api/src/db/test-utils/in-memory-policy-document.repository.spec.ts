import { describe, expect, it } from 'vitest';
import { InMemoryPolicyDocumentRepository } from './in-memory-policy-document.repository';

describe('InMemoryPolicyDocumentRepository', () => {
  it('creates a document with status pending and a null failureCode', async () => {
    const repo = new InMemoryPolicyDocumentRepository();
    const doc = await repo.create('acme', 'Refund policy', 'hash1');
    expect(doc.status).toBe('pending');
    expect(doc.chunkCount).toBe(0);
    expect(doc.failureCode).toBeNull();
    expect(doc.contentHash).toBe('hash1');
  });

  it('markReady is scoped by tenantId and clears any failureCode', async () => {
    const repo = new InMemoryPolicyDocumentRepository();
    const doc = await repo.create('acme', 'Refund policy', 'hash1');

    await repo.markReady('widgetco', doc.id, 5); // wrong tenant - no-op
    expect((await repo.findById('acme', doc.id))?.status).toBe('pending');

    await repo.markReady('acme', doc.id, 5);
    const updated = await repo.findById('acme', doc.id);
    expect(updated?.status).toBe('ready');
    expect(updated?.chunkCount).toBe(5);
    expect(updated?.failureCode).toBeNull();
  });

  it('markFailed is scoped by tenantId and records the failure code', async () => {
    const repo = new InMemoryPolicyDocumentRepository();
    const doc = await repo.create('acme', 'Refund policy', 'hash1');

    await repo.markFailed('acme', doc.id, 'EMBEDDING_FAILED');
    const updated = await repo.findById('acme', doc.id);
    expect(updated?.status).toBe('failed');
    expect(updated?.failureCode).toBe('EMBEDDING_FAILED');
  });

  it("findById returns null for another tenant's document", async () => {
    const repo = new InMemoryPolicyDocumentRepository();
    const doc = await repo.create('acme', 'Refund policy', 'hash1');
    expect(await repo.findById('widgetco', doc.id)).toBeNull();
  });

  it('findByContentHash matches pending or ready documents for the same tenant and hash, never a failed one', async () => {
    const repo = new InMemoryPolicyDocumentRepository();
    const doc = await repo.create('acme', 'Refund policy', 'hash1');

    expect(await repo.findByContentHash('acme', 'hash1')).toMatchObject({ id: doc.id });
    expect(await repo.findByContentHash('widgetco', 'hash1')).toBeNull(); // different tenant, same hash: not a duplicate
    expect(await repo.findByContentHash('acme', 'unrelated-hash')).toBeNull();

    await repo.markFailed('acme', doc.id, 'INTERNAL_ERROR');
    expect(await repo.findByContentHash('acme', 'hash1')).toBeNull(); // a failed document never blocks a retry
  });

  it('countActiveForTenant counts pending and ready documents, never failed ones', async () => {
    const repo = new InMemoryPolicyDocumentRepository();
    const a = await repo.create('acme', 'A', 'h1');
    const b = await repo.create('acme', 'B', 'h2');
    await repo.create('acme', 'C', 'h3'); // stays pending
    await repo.markReady('acme', a.id, 1);
    await repo.markFailed('acme', b.id, 'INTERNAL_ERROR');

    expect(await repo.countActiveForTenant('acme')).toBe(2); // a (ready) + c (pending), not b (failed)
  });

  it('delete is scoped by tenantId and reports whether it deleted anything', async () => {
    const repo = new InMemoryPolicyDocumentRepository();
    const doc = await repo.create('acme', 'Refund policy', 'hash1');

    expect(await repo.delete('widgetco', doc.id)).toBe(false);
    expect(await repo.delete('acme', doc.id)).toBe(true);
    expect(await repo.findById('acme', doc.id)).toBeNull();
  });

  it('findStalePending only returns pending documents older than the cutoff', async () => {
    const repo = new InMemoryPolicyDocumentRepository();
    const stale = await repo.create('acme', 'Stale doc', 'hash1');
    const fresh = await repo.create('acme', 'Fresh doc', 'hash2');
    await repo.markReady('acme', fresh.id, 1); // not pending anymore

    const cutoff = new Date(Date.now() + 1000);
    const results = await repo.findStalePending(cutoff);

    expect(results.map((d) => d.id)).toEqual([stale.id]);
  });
});
