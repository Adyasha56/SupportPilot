import { z } from 'zod';

/**
 * Milestone 5, Stage 1c, item 4 - `GET /v1/connectors`, read-only. Tool
 * name and description ONLY, by design: never `secretRef` (nested inside
 * `request.auth`), never the `request` block itself (method/baseUrl/path/
 * body mapping - PROJECT.md's own connector config shape), never
 * `idPattern`, `inputSchema`, or `responseMap`. Editing configs and
 * testing a tool call from the console are both deferred (PROJECT.md
 * section 7/12 - "Connector configs live in files, not the database").
 */
export const ConnectorSummarySchema = z.object({
  tool: z.string(),
  description: z.string(),
});
export type ConnectorSummary = z.infer<typeof ConnectorSummarySchema>;

export const ConnectorListResponseSchema = z.object({
  connectors: z.array(ConnectorSummarySchema),
});
export type ConnectorListResponse = z.infer<typeof ConnectorListResponseSchema>;
