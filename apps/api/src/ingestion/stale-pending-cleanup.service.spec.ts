import { describe, expect, it, vi } from 'vitest';
import { IngestionSettings } from './ingestion.settings';
import { StalePendingCleanupService } from './stale-pending-cleanup.service';
import { InMemoryPolicyChunkRepository } from '../db/test-utils/in-memory-policy-chunk.repository';
import { InMemoryPolicyDocumentRepository } from '../db/test-utils/in-memory-policy-document.repository';

function settings(overrides: Partial<IngestionSettings> = {}): IngestionSettings {
  return {
    maxFileBytes: 1_000_000,
    titleMaxLength: 200,
    maxChunksPerDocument: 500,
    maxDocumentsPerTenant: 50,
    maxChunksPerTenant: 2000,
    embeddingBatchSize: 16,
    ingestionDeadlineMs: 1000,
    stalePendingMarginMs: 1000,
    ...overrides,
  };
}

describe('StalePendingCleanupService.sweep', () => {
  it('marks a stale pending document failed and deletes its chunks', async () => {
    const documentRepository = new InMemoryPolicyDocumentRepository();
    const chunkRepository = new InMemoryPolicyChunkRepository();
    const service = new StalePendingCleanupService(settings({ ingestionDeadlineMs: 0, stalePendingMarginMs: 0 }), documentRepository, chunkRepository);

    const stale = await documentRepository.create('acme', 'Crashed doc', 'hash1');
    await chunkRepository.insertMany([
      {
        tenantId: 'acme',
        documentId: stale.id,
        title: 'x',
        headingPath: '',
        position: 0,
        text: 'x',
        embedding: [1],
        embeddingModel: 'fake',
        embeddingDimension: 1,
        contentHash: 'h',
      },
    ]);

    // findStalePending compares against "now minus deadline minus margin" -
    // with both at 0 that cutoff is "now", so a document created a moment
    // ago (uploadedAt already in the past relative to "now") qualifies.
    await new Promise((resolve) => setTimeout(resolve, 5));
    const count = await service.sweep();

    expect(count).toBe(1);
    const updated = await documentRepository.findById('acme', stale.id);
    expect(updated?.status).toBe('failed');
    expect(updated?.failureCode).toBe('STALE_PENDING_TIMEOUT');
    expect(await chunkRepository.countForTenant('acme')).toBe(0);
  });

  it('does not touch a pending document that is still within the deadline+margin window', async () => {
    const documentRepository = new InMemoryPolicyDocumentRepository();
    const chunkRepository = new InMemoryPolicyChunkRepository();
    const service = new StalePendingCleanupService(settings({ ingestionDeadlineMs: 60_000, stalePendingMarginMs: 30_000 }), documentRepository, chunkRepository);

    const fresh = await documentRepository.create('acme', 'Fresh doc', 'hash1');
    const count = await service.sweep();

    expect(count).toBe(0);
    expect((await documentRepository.findById('acme', fresh.id))?.status).toBe('pending');
  });

  it('never touches a ready document', async () => {
    const documentRepository = new InMemoryPolicyDocumentRepository();
    const chunkRepository = new InMemoryPolicyChunkRepository();
    const service = new StalePendingCleanupService(settings({ ingestionDeadlineMs: 0, stalePendingMarginMs: 0 }), documentRepository, chunkRepository);

    const doc = await documentRepository.create('acme', 'Ready doc', 'hash1');
    await documentRepository.markReady('acme', doc.id, 3);
    await new Promise((resolve) => setTimeout(resolve, 5));

    const count = await service.sweep();
    expect(count).toBe(0);
    expect((await documentRepository.findById('acme', doc.id))?.status).toBe('ready');
  });

  it('sweep() is a no-op (returns 0) when the database is not configured', async () => {
    const service = new StalePendingCleanupService(settings());
    expect(await service.sweep()).toBe(0);
  });

  it('onModuleInit sets up an interval only when the database is configured, and onModuleDestroy clears it', () => {
    vi.useFakeTimers();
    const setIntervalSpy = vi.spyOn(global, 'setInterval');
    const clearIntervalSpy = vi.spyOn(global, 'clearInterval');

    const unconfigured = new StalePendingCleanupService(settings());
    unconfigured.onModuleInit();
    expect(setIntervalSpy).not.toHaveBeenCalled();

    const documentRepository = new InMemoryPolicyDocumentRepository();
    const chunkRepository = new InMemoryPolicyChunkRepository();
    const configured = new StalePendingCleanupService(settings(), documentRepository, chunkRepository);
    configured.onModuleInit();
    expect(setIntervalSpy).toHaveBeenCalledTimes(1);

    configured.onModuleDestroy();
    expect(clearIntervalSpy).toHaveBeenCalledTimes(1);

    vi.useRealTimers();
  });
});
