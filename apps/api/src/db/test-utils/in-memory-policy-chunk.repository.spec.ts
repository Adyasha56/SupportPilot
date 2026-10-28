import { describe, expect, it } from 'vitest';
import { InMemoryPolicyChunkRepository } from './in-memory-policy-chunk.repository';
import { NewPolicyChunk } from '../policy-chunk.repository';

function chunk(overrides: Partial<NewPolicyChunk>): NewPolicyChunk {
  return {
    tenantId: 'acme',
    documentId: 'doc-1',
    title: 'Refund policy',
    position: 0,
    text: 'Refunds within 30 days.',
    embedding: [1, 0, 0],
    embeddingModel: 'fake',
    embeddingDimension: 3,
    contentHash: 'hash-1',
    ...overrides,
  };
}

describe('InMemoryPolicyChunkRepository', () => {
  it('returns only active chunks', async () => {
    const repo = new InMemoryPolicyChunkRepository();
    await repo.insertMany([chunk({})]);

    const beforeActivation = await repo.vectorSearch({
      tenantId: 'acme',
      queryVector: [1, 0, 0],
      limit: 5,
    });
    expect(beforeActivation).toHaveLength(0);

    await repo.activateForDocument('acme', 'doc-1');
    const afterActivation = await repo.vectorSearch({
      tenantId: 'acme',
      queryVector: [1, 0, 0],
      limit: 5,
    });
    expect(afterActivation).toHaveLength(1);
  });

  it("tenant A never sees tenant B's chunks, even when B's chunk is the closer match", async () => {
    const repo = new InMemoryPolicyChunkRepository();

    // Tenant A's chunk is a mediocre match for the query vector.
    await repo.insertMany([
      chunk({ tenantId: 'acme', documentId: 'doc-a', title: 'A doc', embedding: [0.6, 0.8, 0] }),
    ]);
    // Tenant B's chunk is an EXACT match for the query vector - the closer one.
    await repo.insertMany([
      chunk({ tenantId: 'widgetco', documentId: 'doc-b', title: 'B doc', embedding: [1, 0, 0] }),
    ]);
    await repo.activateForDocument('acme', 'doc-a');
    await repo.activateForDocument('widgetco', 'doc-b');

    const results = await repo.vectorSearch({ tenantId: 'acme', queryVector: [1, 0, 0], limit: 5 });

    expect(results).toHaveLength(1);
    expect(results[0].title).toBe('A doc');
    expect(results.some((r) => r.title === 'B doc')).toBe(false);
  });

  it('deleteForTenant removes only that tenant\'s chunks', async () => {
    const repo = new InMemoryPolicyChunkRepository();
    await repo.insertMany([chunk({ tenantId: 'acme', documentId: 'doc-a' })]);
    await repo.insertMany([chunk({ tenantId: 'widgetco', documentId: 'doc-b' })]);
    await repo.activateForDocument('acme', 'doc-a');
    await repo.activateForDocument('widgetco', 'doc-b');

    await repo.deleteForTenant('acme');

    const acmeResults = await repo.vectorSearch({ tenantId: 'acme', queryVector: [1, 0, 0], limit: 5 });
    const widgetcoResults = await repo.vectorSearch({
      tenantId: 'widgetco',
      queryVector: [1, 0, 0],
      limit: 5,
    });
    expect(acmeResults).toHaveLength(0);
    expect(widgetcoResults).toHaveLength(1);
  });

  it('orders results by descending cosine similarity', async () => {
    const repo = new InMemoryPolicyChunkRepository();
    await repo.insertMany([
      chunk({ documentId: 'doc-1', title: 'far', embedding: [0, 1, 0] }),
      chunk({ documentId: 'doc-2', title: 'near', embedding: [1, 0, 0] }),
    ]);
    await repo.activateForDocument('acme', 'doc-1');
    await repo.activateForDocument('acme', 'doc-2');

    const results = await repo.vectorSearch({ tenantId: 'acme', queryVector: [1, 0, 0], limit: 5 });

    expect(results[0].title).toBe('near');
    expect(results[1].title).toBe('far');
  });
});
