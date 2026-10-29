import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit, Optional } from '@nestjs/common';
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
  private readonly logger = new Logger(StalePendingCleanupService.name);
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
    if (process.env.NODE_ENV === 'test') {
      // Confirmed directly: vitest sets NODE_ENV=test. Without this, any
      // test that bootstraps the real AppModule (e.g. the health e2e test)
      // with a real MONGODB_URI in the environment would start a genuine
      // background timer nothing in that test expects or cleans up itself.
      return;
    }
    const intervalMs = Math.max(this.settings.ingestionDeadlineMs, 10_000);
    this.intervalHandle = setInterval(() => {
      // A failed sweep attempt retries on the next tick rather than
      // crashing the process - but silently was a mistake: with no
      // logging, a sweep that fails every single tick (e.g. a permissions
      // or network issue) would be invisible forever. Logs the error
      // message only - never document content, same rule as every other
      // log line in this pipeline.
      this.sweep().catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        this.logger.error(`Stale-pending sweep failed, will retry next tick: ${message}`);
      });
    }, intervalMs);
    // Doesn't by itself keep the process alive - the HTTP listener already
    // does that. Without unref(), this interval would be the one thing
    // blocking a clean process exit if the server were ever closed first.
    this.intervalHandle.unref();
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
      // Defensive: a document stuck 'pending' should have zero chunks at
      // all (the commit transaction that inserts chunks is the same one
      // that marks 'ready' - a crash before that never gets chunks written
      // at all), and never an ACTIVE one specifically. Scoped to
      // active:false so this sweep can never delete a live, retrievable
      // chunk even if some future bug left one behind.
      await this.chunkRepository.deleteInactiveForDocument(doc.tenantId, doc.id);
      await this.documentRepository.markFailed(doc.tenantId, doc.id, 'STALE_PENDING_TIMEOUT');
    }

    return stale.length;
  }
}
