import { z } from 'zod';

/**
 * Generic safe id shape shared by every tool's identifiers. Tenant-specific
 * formats (e.g. AcmeStore's "ORD-####") are layered on top by callers via
 * the optional `pattern` argument, not baked in here.
 */
export const GENERIC_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/** Cap on the connector-supplied pattern STRING itself, not the id it matches. */
export const MAX_ID_PATTERN_LENGTH = 200;

/**
 * Tenant ids are used to build filesystem paths (connector config fixtures),
 * so this is deliberately stricter than the generic id shape: lowercase
 * only, no dots, short cap - safe to join onto a trusted root directory.
 */
export const TENANT_ID_PATTERN = /^[a-z0-9_-]{1,32}$/;

export const tenantIdSchema = z.string().regex(TENANT_ID_PATTERN, 'must be a valid tenant id');

export function idSchema(pattern?: string): z.ZodString {
  let schema = z.string().regex(GENERIC_ID_PATTERN, 'must match the expected id format');

  if (pattern) {
    if (pattern.length > MAX_ID_PATTERN_LENGTH) {
      throw new Error(`idPattern exceeds maximum length of ${MAX_ID_PATTERN_LENGTH}`);
    }
    schema = schema.regex(new RegExp(pattern), 'must match the connector-specific id format');
  }

  return schema;
}
