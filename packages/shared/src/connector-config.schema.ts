import { z } from 'zod';
import { MAX_ID_PATTERN_LENGTH, tenantIdSchema } from './ids';

/**
 * Restricts which env vars a connector can reference as a secret. Without
 * this, a misconfigured (or malicious) connector config could reference any
 * env var by name - including unrelated secrets like GEMINI_API_KEY, or
 * even non-secret vars like PATH.
 */
export const SECRET_REF_PATTERN = /^CONNECTOR_SECRET_[A-Z0-9_]+$/;

export const ConnectorAuthSchema = z.object({
  type: z.literal('bearer'),
  secretRef: z.string().regex(SECRET_REF_PATTERN, 'must match CONNECTOR_SECRET_[A-Z0-9_]+'),
});

export const ConnectorRequestSchema = z.object({
  method: z.enum(['GET', 'POST']),
  baseUrl: z.string().url(),
  path: z.string().min(1),
  auth: ConnectorAuthSchema,
});

export const ConnectorToolName = z.enum([
  'get_order',
  'track_shipment',
  'issue_refund',
  'escalate_to_human',
]);

export const ConnectorConfigSchema = z.object({
  tenantId: tenantIdSchema,
  tool: ConnectorToolName,
  description: z.string().min(1),
  inputSchema: z.record(z.string(), z.string()),
  request: ConnectorRequestSchema,
  responseMap: z.record(z.string(), z.string()),
  riskLevel: z.enum(['low', 'high']),
  idPattern: z.string().max(MAX_ID_PATTERN_LENGTH).optional(),
});
export type ConnectorConfig = z.infer<typeof ConnectorConfigSchema>;
