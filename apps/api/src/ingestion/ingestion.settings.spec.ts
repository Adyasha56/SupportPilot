import { describe, expect, it } from 'vitest';
import { loadIngestionSettingsFromEnv } from './ingestion.settings';

describe('loadIngestionSettingsFromEnv', () => {
  it('boots with sane defaults when nothing is set', () => {
    const settings = loadIngestionSettingsFromEnv({});
    expect(settings.maxFileBytes).toBeGreaterThan(0);
    expect(settings.maxChunksPerDocument).toBeGreaterThan(0);
    expect(settings.maxDocumentsPerTenant).toBeGreaterThan(0);
    expect(settings.maxChunksPerTenant).toBeGreaterThan(0);
    expect(settings.embeddingBatchSize).toBeGreaterThan(0);
    expect(settings.ingestionDeadlineMs).toBeGreaterThan(0);
  });

  it('picks up every overridable value from env', () => {
    const settings = loadIngestionSettingsFromEnv({
      INGESTION_MAX_FILE_BYTES: '500000',
      INGESTION_TITLE_MAX_LENGTH: '100',
      INGESTION_MAX_CHUNKS_PER_DOCUMENT: '50',
      INGESTION_MAX_DOCUMENTS_PER_TENANT: '5',
      INGESTION_MAX_CHUNKS_PER_TENANT: '200',
      INGESTION_EMBEDDING_BATCH_SIZE: '4',
      INGESTION_DEADLINE_MS: '10000',
      INGESTION_STALE_PENDING_MARGIN_MS: '5000',
    });

    expect(settings).toEqual({
      maxFileBytes: 500000,
      titleMaxLength: 100,
      maxChunksPerDocument: 50,
      maxDocumentsPerTenant: 5,
      maxChunksPerTenant: 200,
      embeddingBatchSize: 4,
      ingestionDeadlineMs: 10000,
      stalePendingMarginMs: 5000,
    });
  });

  it('throws a clear error on an invalid value rather than silently coercing it', () => {
    expect(() => loadIngestionSettingsFromEnv({ INGESTION_MAX_FILE_BYTES: 'not-a-number' })).toThrow(/Invalid IngestionSettings/);
  });
});
