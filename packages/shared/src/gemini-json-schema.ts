import { z } from 'zod';

/**
 * The exact keyword subset Gemini's `responseJsonSchema` documents as
 * supported - confirmed by reading the installed @google/genai@2.31.0 SDK's
 * own `GenerateContentConfig.responseJsonSchema` doc comment directly (this
 * level of detail isn't on ai.google.dev's own docs pages), 2026-10-31.
 *
 * `const` is deliberately NOT in this list - only `enum` is. Every Zod
 * schema in this project whose JSON Schema form is sent to Gemini must
 * express single-value discrimination (e.g. a tool-name discriminant) via a
 * singleton `z.enum([...])`, never `z.literal(...)` - z.literal compiles to
 * `const` (verified directly against the installed zod@4.6.7), a singleton
 * z.enum compiles to `enum` with one entry, and a `z.discriminatedUnion`
 * built from singleton-enum branches round-trips through
 * `z.toJSONSchema()` as `oneOf` (itself supported, documented as
 * "interpreted the same as anyOf") with no `const` anywhere - confirmed
 * directly, not assumed.
 */
export const GEMINI_RESPONSE_JSON_SCHEMA_KEYWORDS = new Set([
  '$id',
  '$defs',
  '$ref',
  '$anchor',
  'type',
  'format',
  'title',
  'description',
  'enum',
  'items',
  'prefixItems',
  'minItems',
  'maxItems',
  'minimum',
  'maximum',
  'anyOf',
  'oneOf',
  'properties',
  'additionalProperties',
  'required',
  /** Non-standard, but explicitly documented by the SDK as supported. */
  'propertyOrdering',
]);

/**
 * zod's z.toJSONSchema() always adds a top-level `$schema` meta key -
 * confirmed directly against zod@4.6.7, with no option to suppress it.
 * Gemini's own docs don't mention `$schema` at all, and it serves no
 * functional purpose for `responseJsonSchema` (it's metadata about which
 * JSON Schema dialect this is, not a validation keyword) - stripped here so
 * it's never mistaken for part of "the schema Gemini actually needs to
 * understand." (It was empirically harmless when left in during Stage 1's
 * manual real-API check, but stripping it keeps the compatibility test
 * below meaningful rather than needing a special-cased exception for it.)
 */
export function toGeminiResponseJsonSchema(schema: z.ZodType): Record<string, unknown> {
  const jsonSchema = { ...(z.toJSONSchema(schema) as Record<string, unknown>) };
  delete jsonSchema.$schema;
  return jsonSchema;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Recursively collects every JSON-Schema KEYWORD key actually present in a
 * schema produced by toGeminiResponseJsonSchema() - never a user-defined
 * field name (e.g. "order_id"), an `enum` member value (e.g. "get_order"),
 * or a `required` list entry. Only keywords whose value is itself one or
 * more nested schemas are recursed into (`properties`/`$defs` as maps,
 * `anyOf`/`oneOf`/`prefixItems` as arrays, `items` as either, a
 * schema-shaped `additionalProperties`) - every other keyword's value
 * (`required`'s string array, `enum`'s value array, `type`'s string, etc.)
 * is a leaf, added as a keyword but never descended into.
 */
export function collectJsonSchemaKeywords(node: unknown, into: Set<string> = new Set()): Set<string> {
  if (Array.isArray(node)) {
    for (const item of node) {
      collectJsonSchemaKeywords(item, into);
    }
    return into;
  }
  if (!isPlainObject(node)) {
    return into;
  }

  for (const key of Object.keys(node)) {
    into.add(key);
  }

  if (isPlainObject(node.properties)) {
    for (const sub of Object.values(node.properties)) {
      collectJsonSchemaKeywords(sub, into);
    }
  }
  if (isPlainObject(node.$defs)) {
    for (const sub of Object.values(node.$defs)) {
      collectJsonSchemaKeywords(sub, into);
    }
  }
  for (const key of ['anyOf', 'oneOf', 'prefixItems'] as const) {
    if (Array.isArray(node[key])) {
      collectJsonSchemaKeywords(node[key], into);
    }
  }
  if (node.items !== undefined) {
    collectJsonSchemaKeywords(node.items, into);
  }
  if (isPlainObject(node.additionalProperties)) {
    collectJsonSchemaKeywords(node.additionalProperties, into);
  }

  return into;
}

/** Convenience used by tests: every keyword actually used, minus the allowed set - empty means fully compatible. */
export function unsupportedGeminiKeywords(schema: z.ZodType): string[] {
  const used = collectJsonSchemaKeywords(toGeminiResponseJsonSchema(schema));
  return [...used].filter((keyword) => !GEMINI_RESPONSE_JSON_SCHEMA_KEYWORDS.has(keyword));
}
