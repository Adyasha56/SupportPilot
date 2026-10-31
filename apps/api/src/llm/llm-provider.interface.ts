/**
 * RETRIEVAL_DOCUMENT for policy chunks at ingestion time, RETRIEVAL_QUERY
 * for the customer message at retrieval time - asymmetric embeddings, per
 * Gemini's own docs, produce better matches than embedding both sides the
 * same way. Other task types the model supports (classification,
 * clustering, etc.) aren't used anywhere in this project, so they're left
 * out rather than speculatively supported.
 */
export type EmbeddingTaskType = 'RETRIEVAL_DOCUMENT' | 'RETRIEVAL_QUERY';

export interface EmbeddingVector {
  text: string;
  values: number[];
}

export interface EmbedResult {
  vectors: EmbeddingVector[];
  model: string;
  dimension: number;
}

export type EmbedErrorCode = 'NOT_CONFIGURED' | 'INVALID_INPUT' | 'RATE_LIMITED' | 'UNAUTHORIZED' | 'TRANSIENT' | 'UNAVAILABLE';

export interface EmbedError {
  code: EmbedErrorCode;
  message: string;
}

/**
 * A result type, not a thrown exception - matching the tool runner's
 * established pattern (Milestone 1) of never throwing for expected
 * failures. Rate limits, bad input, and a missing API key are all expected,
 * routine outcomes for an embedding call, not exceptional ones.
 */
export type EmbedOutcome = { ok: true; result: EmbedResult } | { ok: false; error: EmbedError };

/**
 * One message in the conversation sent to generate() - 'model' is a PRIOR
 * assistant turn (e.g. the repair-attempt flow re-sends the model's own
 * invalid output as a 'model' turn before asking it to retry), 'user' is
 * everything else: the customer message and all untrusted content
 * (policy chunks, tool results), wrapped in the caller's own boundary
 * markers (see apps/api/src/agent's prompt-boundary design) - generate()
 * itself has no opinion on untrusted-content framing, that's the caller's
 * job, same as embed() has no opinion on what text means.
 */
export interface GenerateMessage {
  role: 'user' | 'model';
  text: string;
}

export interface GenerateOptions {
  /** ALWAYS the only place instructions live - never built from messages[]. */
  systemInstruction: string;
  messages: GenerateMessage[];
  /**
   * A JSON Schema object (e.g. from Zod 4's native `z.toJSONSchema()`) - NOT
   * the Gemini SDK's own narrower `Schema` type. Sent as the SDK's
   * `responseJsonSchema` field (not `responseSchema`), confirmed directly
   * against the installed @google/genai@2.31.0 type declarations as the
   * field meant for a real JSON Schema object; its own doc comment lists
   * the exact supported keyword subset (notably: `anyOf`/`oneOf` yes,
   * `const` not listed - only `enum`).
   */
  responseSchema: Record<string, unknown>;
  maxOutputTokens: number;
  /** 0 in deterministic/eval mode - see PROJECT.md's Milestone 6 note: not a byte-identical-output guarantee, only a variance reducer. */
  temperature: number;
  timeoutMs: number;
}

export type GenerateErrorCode =
  | 'NOT_CONFIGURED'
  | 'INVALID_INPUT'
  | 'RATE_LIMITED'
  | 'UNAUTHORIZED'
  | 'TRANSIENT'
  | 'UNAVAILABLE'
  /** The SDK returned a response, but its text wasn't valid JSON at all - distinct from the caller's OWN Zod schema rejecting a validly-shaped-but-wrong JSON value, which generate() has no way to know about (it only knows the raw JSON Schema object it was given, not the Zod type it came from). */
  | 'INVALID_OUTPUT';

export interface GenerateError {
  code: GenerateErrorCode;
  message: string;
}

export interface GenerateUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface GenerateResult {
  text: string;
  usage: GenerateUsage;
}

export type GenerateOutcome = { ok: true; result: GenerateResult } | { ok: false; error: GenerateError };

export interface LlmProvider {
  embed(texts: string[], taskType: EmbeddingTaskType): Promise<EmbedOutcome>;
  generate(options: GenerateOptions): Promise<GenerateOutcome>;
}
