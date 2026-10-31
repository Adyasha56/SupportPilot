import { z } from 'zod';
import { GENERIC_ID_PATTERN, idSchema } from './ids';
import { hasAtMostTwoDecimals } from './money';
import { IssueRefundInputSchema } from './tool-schemas';

/**
 * Gemini's `responseJsonSchema` supports no string-length, pattern, or
 * exclusive-bound keywords at all (confirmed empirically: converting
 * `idSchema()` and `moneyAmountSchema` - both perfectly normal elsewhere in
 * this project - through `z.toJSONSchema()` emits `pattern`, `maxLength`,
 * and `exclusiveMinimum`, none of which are in
 * GEMINI_RESPONSE_JSON_SCHEMA_KEYWORDS; see gemini-json-schema.spec.ts's
 * compatibility test, which caught exactly this). The two schemas actually
 * sent to Gemini as a `responseJsonSchema` - PlannerOutputSchema and
 * ComposeOutputSchema - therefore build their field-level checks with
 * `.refine()` instead of `.max()`/`.regex()`/`.positive()`: `z.toJSONSchema()`
 * drops refinements entirely (confirmed empirically - a refined schema's
 * JSON Schema is identical to its unrefined base shape), so the SAME rule
 * is enforced at parse time against the model's real output, while the
 * schema Gemini actually sees carries only the keywords it documents as
 * supported. `idSchema()`/`moneyAmountSchema` themselves are untouched -
 * every other schema in this project that is never sent to Gemini
 * (ProposedActionSchema, ChatRequestSchema, ChatResultSchema, tool-schemas,
 * connector configs) keeps using them exactly as before.
 */
function geminiSafeId(): z.ZodString {
  return z.string().refine((value) => GENERIC_ID_PATTERN.test(value), 'must match the expected id format');
}

function geminiSafeMaxLength(max: number): z.ZodString {
  return z.string().refine((value) => value.length <= max, `must be at most ${max} characters`);
}

/** Positive, at most two decimal places - same rule as moneyAmountSchema, refine-based so it never surfaces as the unsupported `exclusiveMinimum` keyword. */
const geminiSafeMoneyAmountSchema = z
  .number()
  .refine((value) => value > 0, 'amount must be positive')
  .refine(hasAtMostTwoDecimals, 'amount must have at most two decimal places');

export const MAX_PLANNER_TOOL_REQUESTS = 3;
export const PLANNER_REASONING_MAX_LENGTH = 300;
export const PLANNER_SEARCH_QUERY_MAX_LENGTH = 500;
export const COMPOSE_MESSAGE_MAX_LENGTH = 1200;

/**
 * Discriminated by a SINGLETON z.enum per branch, never z.literal - see
 * gemini-json-schema.ts's doc comment for why (z.literal compiles to
 * `const`, which Gemini's responseJsonSchema does not support; a singleton
 * enum compiles to `enum`, which it does). Only the two read-only tools:
 * the planner is structurally unable to request issue_refund or
 * escalate_to_human - those never appear in this union at all, so there is
 * no args shape for them to validate against here. Explicit typed fields
 * only - no free-form `args: z.record(...)`, so the model can never send an
 * argument this schema doesn't know about. `.strict()` on each branch makes
 * zod actually REJECT an unrecognized extra field at parse time, matching
 * the `additionalProperties: false` the JSON Schema conversion emits
 * regardless (confirmed empirically: z.toJSONSchema() emits
 * `additionalProperties: false` for a plain, non-strict z.object() too -
 * without `.strict()` here, a model response with a stray field would be
 * silently stripped and accepted, not rejected as the invalid structured
 * output it actually is).
 */
export const PlannerToolRequestSchema = z.discriminatedUnion('tool', [
  z.object({ tool: z.enum(['get_order']), order_id: geminiSafeId().describe('The order id, e.g. ORD-1001.') }).strict(),
  z.object({ tool: z.enum(['track_shipment']), order_id: geminiSafeId().describe('The order id, e.g. ORD-1001.') }).strict(),
]);
export type PlannerToolRequest = z.infer<typeof PlannerToolRequestSchema>;

/**
 * Call 1's output (PROJECT.md's Agent loop design, call 1/`plan`).
 * `searchQuery` is required exactly when `needsPolicy` is true - enforced
 * by the `.superRefine()` below, not by the JSON Schema sent to Gemini
 * (conditional-required isn't in Gemini's supported keyword list at all;
 * confirmed `z.toJSONSchema()` drops refinements entirely and emits only
 * the base shape, so this rule is ours to enforce after parsing the
 * model's output, not something the API call itself can guarantee). A
 * response violating it fails our own `safeParse` and is treated as
 * invalid structured output - PROJECT.md's one-repair-attempt path.
 */
export const PlannerOutputSchema = z
  .object({
    /** For the audit trail only - never shown to the customer. */
    reasoning: geminiSafeMaxLength(PLANNER_REASONING_MAX_LENGTH).describe(`Brief reasoning, at most ${PLANNER_REASONING_MAX_LENGTH} characters.`),
    needsPolicy: z.boolean(),
    searchQuery: geminiSafeMaxLength(PLANNER_SEARCH_QUERY_MAX_LENGTH)
      .describe(`Required when needsPolicy is true, at most ${PLANNER_SEARCH_QUERY_MAX_LENGTH} characters.`)
      .optional(),
    toolRequests: z.array(PlannerToolRequestSchema).max(MAX_PLANNER_TOOL_REQUESTS),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.needsPolicy && !value.searchQuery) {
      ctx.addIssue({ code: 'custom', message: 'searchQuery is required when needsPolicy is true', path: ['searchQuery'] });
    }
  });
export type PlannerOutput = z.infer<typeof PlannerOutputSchema>;

/**
 * Call 2's output (PROJECT.md's Agent loop design, call 2/`compose`). The
 * model can only ever say `propose_refund` - never `pending_approval`.
 * `pending_approval` is a CODE-level outcome: it exists only in
 * ChatOutcomeSchema below, produced by converting a validated
 * `propose_refund` (see validate-proposed-refund.ts) into a
 * ProposedAction. The model never sees or writes that word.
 */
export const ComposeOutcomeSchema = z.enum(['reply', 'clarify', 'escalate', 'propose_refund']);
export type ComposeOutcome = z.infer<typeof ComposeOutcomeSchema>;

export const MAX_CITED_CHUNK_KEYS = 5;

export const ComposeOutputSchema = z
  .object({
    outcome: ComposeOutcomeSchema,
    message: geminiSafeMaxLength(COMPOSE_MESSAGE_MAX_LENGTH).describe(`The reply to the customer, at most ${COMPOSE_MESSAGE_MAX_LENGTH} characters.`),
    citedChunkKeys: z.array(z.string()).max(MAX_CITED_CHUNK_KEYS),
    /**
     * The model's claim only - never executed, never trusted as-is. Code
     * re-derives `remainingRefundable` and generates `idempotencyKey`
     * itself (validate-proposed-refund.ts); nothing here is passed through
     * unchecked.
     */
    proposedRefund: z
      .object({ order_id: geminiSafeId().describe('The order id, e.g. ORD-1001.'), amount: geminiSafeMoneyAmountSchema })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.outcome === 'propose_refund' && !value.proposedRefund) {
      ctx.addIssue({ code: 'custom', message: 'proposedRefund is required when outcome is propose_refund', path: ['proposedRefund'] });
    }
    if (value.outcome !== 'propose_refund' && value.proposedRefund) {
      ctx.addIssue({ code: 'custom', message: 'proposedRefund must be omitted unless outcome is propose_refund', path: ['proposedRefund'] });
    }
  });
export type ComposeOutput = z.infer<typeof ComposeOutputSchema>;

/**
 * The code-finalized action a validated `propose_refund` becomes
 * (validate-proposed-refund.ts) - never model-generated JSON, so a plain
 * z.literal is fine here; this is never converted to a Gemini
 * responseJsonSchema. `args` reuses the EXISTING, already-validated
 * issue_refund tool input schema rather than redefining its shape, so the
 * two can never drift apart.
 */
export const ProposedActionSchema = z.object({
  tool: z.literal('issue_refund'),
  args: IssueRefundInputSchema,
  /** chunkKeys the compose call claimed support this refund - re-checked against the actually-retrieved set by citation-guard.ts, same as every other citation. */
  reasonCitations: z.array(z.string()),
});
export type ProposedAction = z.infer<typeof ProposedActionSchema>;

/** The public outcome vocabulary PROJECT.md section 6's /v1/chat response shape documents - distinct from ComposeOutcomeSchema, which the model writes directly. */
export const ChatOutcomeSchema = z.enum(['reply', 'clarify', 'escalate', 'pending_approval']);
export type ChatOutcome = z.infer<typeof ChatOutcomeSchema>;

export const CitationSchema = z.object({
  chunkKey: z.string(),
  documentTitle: z.string(),
  headingPath: z.string(),
});
export type Citation = z.infer<typeof CitationSchema>;

export const MAX_CHAT_MESSAGE_LENGTH = 4000;

export const ChatRequestSchema = z.object({
  message: z.string().min(1).max(MAX_CHAT_MESSAGE_LENGTH),
  conversationId: idSchema().optional(),
  /** Verified in the controller (Stage 5), not here - see identity/customer-token.ts. */
  customerToken: z.string().max(1000).optional(),
  /**
   * Only ever honored for a secret-scope (server-to-server) caller. The
   * schema can't know the caller's scope - that's resolved from the API
   * key (RULES.md section 5), never from the request body - so this field
   * is a structural placeholder only; the controller is what enforces
   * "ignored unless the caller authenticated with a secret key."
   */
  customerRef: idSchema().optional(),
});
export type ChatRequest = z.infer<typeof ChatRequestSchema>;

export const ChatResultSchema = z.object({
  conversationId: z.string(),
  runId: z.string(),
  outcome: ChatOutcomeSchema,
  message: z.string(),
  citations: z.array(CitationSchema),
  proposedAction: ProposedActionSchema.optional(),
});
export type ChatResult = z.infer<typeof ChatResultSchema>;
