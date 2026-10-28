import { z } from 'zod';

export const IngestionSettingsSchema = z.object({
  maxFileBytes: z.number().int().positive(),
  titleMaxLength: z.number().int().positive(),
  /** Per-document cap, passed straight through to chunkMarkdown's own maxChunks option. */
  maxChunksPerDocument: z.number().int().positive(),
  /** Across every ready/pending document a tenant has. */
  maxDocumentsPerTenant: z.number().int().positive(),
  /** Across every chunk a tenant has, over all their documents. */
  maxChunksPerTenant: z.number().int().positive(),
  /**
   * How many chunks go into one embed() call. Must stay comfortably under
   * the LLM provider's own maxTextsPerBatch (apps/api/src/llm/llm.settings.ts,
   * default 32) - this is deliberately smaller by default so a full batch
   * from here never gets rejected as INVALID_INPUT by the provider.
   */
  embeddingBatchSize: z.number().int().positive(),
  /** Wall-clock budget for the whole chunk+embed+commit pipeline, checked between embedding batches. */
  ingestionDeadlineMs: z.number().int().positive(),
  /** Added on top of ingestionDeadlineMs before the stale-pending sweep gives up on a document and marks it failed. */
  stalePendingMarginMs: z.number().int().nonnegative(),
});
export type IngestionSettings = z.infer<typeof IngestionSettingsSchema>;

export function loadIngestionSettingsFromEnv(env: NodeJS.ProcessEnv): IngestionSettings {
  const candidate = {
    maxFileBytes: Number(env.INGESTION_MAX_FILE_BYTES ?? 1_000_000),
    titleMaxLength: Number(env.INGESTION_TITLE_MAX_LENGTH ?? 200),
    maxChunksPerDocument: Number(env.INGESTION_MAX_CHUNKS_PER_DOCUMENT ?? 500),
    maxDocumentsPerTenant: Number(env.INGESTION_MAX_DOCUMENTS_PER_TENANT ?? 50),
    maxChunksPerTenant: Number(env.INGESTION_MAX_CHUNKS_PER_TENANT ?? 2000),
    embeddingBatchSize: Number(env.INGESTION_EMBEDDING_BATCH_SIZE ?? 16),
    ingestionDeadlineMs: Number(env.INGESTION_DEADLINE_MS ?? 60_000),
    stalePendingMarginMs: Number(env.INGESTION_STALE_PENDING_MARGIN_MS ?? 30_000),
  };

  const result = IngestionSettingsSchema.safeParse(candidate);
  if (!result.success) {
    throw new Error(`Invalid IngestionSettings: ${result.error.message}`);
  }
  return result.data;
}
