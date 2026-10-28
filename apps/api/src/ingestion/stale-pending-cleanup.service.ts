import { Inject, Injectable, OnModuleDestroy, OnModuleInit, Optional } from '@nestjs/common';
import { INGESTION_SETTINGS } from './ingestion-settings.provider';
import { IngestionSettings } from './ingestion.settings';
import { POLICY_CHUNK_REPOSITORY, PolicyChunkRepository } from '../db/policy-chunk.repository';
import { POLICY_DOCUMENT_REPOSITORY, PolicyDocumentRepository } from '../db/policy-document.repository';

/**
 * An interval, not a new dependency (just the global setInterval) - a
 * document stuck 'pending' past ingestionDeadlineMs + stalePendingMarginMs
 * means the process crashed mid-pipeline (the deadline check inside
 * PolicyIngestionService itself only catches a slow-but-alive process,
 * not a dead one). sweep() is public and synchronously awaitable so tests
 * call it directly, without waiting on a real timer.
 */
@Injectable()
export class StalePendingCleanupService implements OnModuleInit, OnModuleDestroy {
  private intervalHandle: ReturnType<typeof setInterval> | undefined;

  constructor(
    @Inject(INGESTION_SETTINGS) private readonly settings: IngestionSettings,
    @Optional() @Inject(POLICY_DOCUMENT_REPOSITORY) private readonly documentRepository?: PolicyDocumentRepository,
    @Optional() @Inject(POLICY_CHUNK_REPOSITORY) private readonly chunkRepository?: PolicyChunkRepository,
  ) {}

  onModuleInit(): void {
    if (!this.documentRepository || !this.chunkRepository) {
      return; // no database configured - nothing to sweep, same "boot without DB" story as the rest of the app
    }
    const intervalMs = Math.max(this.settings.ingestionDeadlineMs, 10_000);
    this.intervalHandle = setInterval(() => {
      this.sweep().catch(() => undefined); // a failed sweep attempt just retries on the next tick, never crashes the process
    }, intervalMs);
  }

  onModuleDestroy(): void {
    if (this.intervalHandle) {
      clearInterval(this.intervalHandle);
    }
  }

  /** Returns how many stale documents were cleaned up - exposed for tests and for a future manual-trigger endpoint. */
  async sweep(): Promise<number> {
    if (!this.documentRepository || !this.chunkRepository) {
      return 0;
    }
    const cutoff = new Date(Date.now() - this.settings.ingestionDeadlineMs - this.settings.stalePendingMarginMs);
    const stale = await this.documentRepository.findStalePending(cutoff);

    for (const doc of stale) {
      // Defensive: a document stuck 'pending' should have zero chunks (the
      // commit transaction that inserts chunks is the same one that marks
      // 'ready' - a crash before that never gets chunks written at all).
      // Deleting here anyway costs nothing and guards against any edge case.
      await this.chunkRepository.deleteForDocument(doc.tenantId, doc.id);
      await this.documentRepository.markFailed(doc.tenantId, doc.id, 'STALE_PENDING_TIMEOUT');
    }

    return stale.length;
  }
}
