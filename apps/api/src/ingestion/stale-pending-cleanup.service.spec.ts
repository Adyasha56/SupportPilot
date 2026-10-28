import { describe, expect, it, vi } from 'vitest';
import { IngestionSettings } from './ingestion.settings';
import { StalePendingCleanupService } from './stale-pending-cleanup.service';
import { NewPolicyChunk } from '../db/policy-chunk.repository';
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

function chunkFixture(overrides: Partial<NewPolicyChunk> = {}): NewPolicyChunk {
  return {
    tenantId: 'acme',
    documentId: 'placeholder',
    title: 'x',
    headingPath: '',
    position: 0,
    text: 'x',
    embedding: [1],
    embeddingModel: 'fake',
    embeddingDimension: 1,
    contentHash: 'h',
    ...overrides,
  };
}

describe('StalePendingCleanupService.sweep', () => {
  it('marks a stale pending document failed and deletes its (inactive) chunks', async () => {
    const documentRepository = new InMemoryPolicyDocumentRepository();
    const chunkRepository = new InMemoryPolicyChunkRepository();
    const service = new StalePendingCleanupService(settings({ ingestionDeadlineMs: 0, stalePendingMarginMs: 0 }), documentRepository, chunkRepository);

    const stale = await documentRepository.create('acme', 'Crashed doc', 'hash1');
    await chunkRepository.insertMany([chunkFixture({ documentId: stale.id })]);
    // A pending document should never have an active chunk in practice -
    // deactivating here simulates the one edge case the sweep is actually
    // meant to clean up: a leftover INACTIVE chunk.
    await chunkRepository.deactivateForDocument('acme', stale.id);

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

  it('never deletes an ACTIVE chunk, even for a document the sweep is about to fail', async () => {
    const documentRepository = new InMemoryPolicyDocumentRepository();
    const chunkRepository = new InMemoryPolicyChunkRepository();
    const service = new StalePendingCleanupService(settings({ ingestionDeadlineMs: 0, stalePendingMarginMs: 0 }), documentRepository, chunkRepository);

    const stale = await documentRepository.create('acme', 'Crashed doc', 'hash1');
    // Left active on purpose - a defensive edge case (e.g. a future bug)
    // the sweep must never touch, since it would be a live, retrievable chunk.
    await chunkRepository.insertMany([chunkFixture({ documentId: stale.id })]);

    await new Promise((resolve) => setTimeout(resolve, 5));
    await service.sweep();

    expect(await chunkRepository.countForTenant('acme')).toBe(1); // untouched
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

  it('never starts a real interval while NODE_ENV=test (confirmed: that is what vitest sets)', () => {
    vi.useFakeTimers();
    const setIntervalSpy = vi.spyOn(global, 'setInterval');

    const documentRepository = new InMemoryPolicyDocumentRepository();
    const chunkRepository = new InMemoryPolicyChunkRepository();
    const service = new StalePendingCleanupService(settings(), documentRepository, chunkRepository);
    service.onModuleInit();

    expect(process.env.NODE_ENV).toBe('test');
    expect(setIntervalSpy).not.toHaveBeenCalled();

    vi.useRealTimers();
  });

  it('outside test env: sets up an unref\'d interval only when the database is configured, and onModuleDestroy clears it', () => {
    vi.useFakeTimers();
    vi.stubEnv('NODE_ENV', 'production');
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
    const returnedHandle = setIntervalSpy.mock.results[0].value as { hasRef?: () => boolean };
    // Node's Timeout exposes hasRef() to confirm unref() actually took effect.
    if (typeof returnedHandle.hasRef === 'function') {
      expect(returnedHandle.hasRef()).toBe(false);
    }

    configured.onModuleDestroy();
    expect(clearIntervalSpy).toHaveBeenCalledTimes(1);

    vi.unstubAllEnvs();
    vi.useRealTimers();
  });
});
