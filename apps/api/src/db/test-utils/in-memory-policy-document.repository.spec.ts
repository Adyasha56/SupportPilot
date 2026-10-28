import { describe, expect, it } from 'vitest';
import { InMemoryPolicyDocumentRepository } from './in-memory-policy-document.repository';

describe('InMemoryPolicyDocumentRepository', () => {
  it('creates a document with status pending', async () => {
    const repo = new InMemoryPolicyDocumentRepository();
    const doc = await repo.create('acme', 'Refund policy');
    expect(doc.status).toBe('pending');
    expect(doc.chunkCount).toBe(0);
  });

  it('markReady is scoped by tenantId', async () => {
    const repo = new InMemoryPolicyDocumentRepository();
    const doc = await repo.create('acme', 'Refund policy');

    await repo.markReady('widgetco', doc.id, 5); // wrong tenant - no-op
    expect((await repo.findById('acme', doc.id))?.status).toBe('pending');

    await repo.markReady('acme', doc.id, 5);
    const updated = await repo.findById('acme', doc.id);
    expect(updated?.status).toBe('ready');
    expect(updated?.chunkCount).toBe(5);
  });

  it('findById returns null for another tenant\'s document', async () => {
    const repo = new InMemoryPolicyDocumentRepository();
    const doc = await repo.create('acme', 'Refund policy');
    expect(await repo.findById('widgetco', doc.id)).toBeNull();
  });

  it('delete is scoped by tenantId and reports whether it deleted anything', async () => {
    const repo = new InMemoryPolicyDocumentRepository();
    const doc = await repo.create('acme', 'Refund policy');

    expect(await repo.delete('widgetco', doc.id)).toBe(false);
    expect(await repo.delete('acme', doc.id)).toBe(true);
    expect(await repo.findById('acme', doc.id)).toBeNull();
  });

  it('findStalePending only returns pending documents older than the cutoff', async () => {
    const repo = new InMemoryPolicyDocumentRepository();
    const stale = await repo.create('acme', 'Stale doc');
    const fresh = await repo.create('acme', 'Fresh doc');
    await repo.markReady('acme', fresh.id, 1); // not pending anymore

    const cutoff = new Date(Date.now() + 1000);
    const results = await repo.findStalePending(cutoff);

    expect(results.map((d) => d.id)).toEqual([stale.id]);
  });
});
