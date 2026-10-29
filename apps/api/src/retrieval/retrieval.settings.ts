import { z } from 'zod';

export const RetrievalSettingsSchema = z.object({
  maxQueryLength: z.number().int().positive(),
  defaultTopK: z.number().int().positive(),
  /** A request asking for more than this is clamped down to it, never rejected - see PolicyRetrievalService.retrieve(). */
  maxTopK: z.number().int().positive(),
});
export type RetrievalSettings = z.infer<typeof RetrievalSettingsSchema>;

export function loadRetrievalSettingsFromEnv(env: NodeJS.ProcessEnv): RetrievalSettings {
  const candidate = {
    maxQueryLength: Number(env.RETRIEVAL_MAX_QUERY_LENGTH ?? 2000),
    defaultTopK: Number(env.RETRIEVAL_DEFAULT_TOP_K ?? 5),
    maxTopK: Number(env.RETRIEVAL_MAX_TOP_K ?? 10),
  };

  const result = RetrievalSettingsSchema.safeParse(candidate);
  if (!result.success) {
    throw new Error(`Invalid RetrievalSettings: ${result.error.message}`);
  }
  return result.data;
}
