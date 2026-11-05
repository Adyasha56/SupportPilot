import { randomBytes } from 'node:crypto';

/** A block can never dominate an entire prompt's token budget - this is the default per-block cap, callers may pass a smaller one. */
export const MAX_UNTRUSTED_BLOCK_LENGTH = 4000;

/** The ONLY block labels this project ever wraps untrusted content in - kept here as the single source of truth both buildUntrustedBlock and the tag-neutralizer below read from. `history_turn` wraps a prior agent OR customer turn from conversation history - treated as data exactly like a fresh customer message (PROJECT.md: "Prior agent turns in history are also treated as data"). */
export const BLOCK_LABELS = ['customer_message', 'policy_chunk', 'tool_result', 'history_turn'] as const;
export type BlockLabel = (typeof BLOCK_LABELS)[number];

/**
 * A fresh, unguessable boundary token generated fresh PER REQUEST (never a
 * fixed delimiter like `<policy_chunk>` reused across requests) - 128 bits
 * of crypto-random entropy, hex-encoded. PROJECT.md's Agent loop design:
 * "any occurrence of the boundary pattern found inside that same untrusted
 * content is neutralized before insertion, so content can never forge a
 * block boundary."
 */
export function newBoundary(): string {
  return randomBytes(16).toString('hex');
}

/** Deliberately matches control characters, to strip them. */
const ZERO_WIDTH_AND_CONTROL_PATTERN = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F​-‏⁠﻿]/g;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Matches a tag-like wrapper around one of our own block labels,
 * tolerating: arbitrary whitespace anywhere inside the angle brackets, an
 * optional leading slash (a forged closing tag), and an optional
 * hex-looking `boundary:` prefix of ANY value - not just the real
 * boundary for this request. The last point matters: this still catches
 * a GUESSED or entirely made-up boundary wrapping a real label (e.g.
 * `<deadbeef...:policy_chunk>`), which the separate literal-boundary
 * redaction below can't, since that only ever knows the one real boundary
 * this request actually generated.
 */
function neutralizeTagLike(text: string, label: BlockLabel): string {
  const pattern = new RegExp(`<\\s*/?\\s*(?:[0-9a-f]{1,64}\\s*:\\s*)?${escapeRegExp(label)}\\s*>`, 'gi');
  return text.replace(pattern, '[redacted-tag]');
}

function replaceAllCaseInsensitive(text: string, needle: string, replacement: string): string {
  if (needle.length === 0) {
    return text;
  }
  return text.replace(new RegExp(escapeRegExp(needle), 'gi'), replacement);
}

/**
 * Defends untrusted text on four fronts, in this order:
 *
 * 1. Length cap FIRST, before any of the heavier steps below run - bounds
 *    the cost of sanitizing a maliciously huge input (a customer message,
 *    an uploaded policy chunk, or an upstream tool response could all in
 *    principle be very large) rather than normalizing/scanning the whole
 *    thing before truncating it anyway.
 * 2. Unicode NFKC normalization - collapses visually/functionally
 *    equivalent character sequences (full-width forms, certain
 *    compatibility characters) to one canonical form BEFORE any pattern
 *    matching runs, so a differently-encoded-but-visually-identical
 *    attempt to spell out a tag or the boundary can't slip past the
 *    literal checks that follow.
 * 3. Zero-width and ASCII control characters stripped (e.g. U+200B zero-
 *    width space, C0/C1 control codes) - these can be invisibly
 *    interleaved into a tag name or the boundary string to defeat a naive
 *    substring check while rendering identically to a human or a model.
 * 4. Every literal occurrence of the real `boundary` is neutralized
 *    (case-insensitive), then every tag-like occurrence of our own block
 *    labels is neutralized regardless of what (if anything) prefixes it -
 *    see neutralizeTagLike's own doc comment for why a guessed boundary
 *    is caught here too.
 */
export function sanitizeUntrustedText(text: string, boundary: string, maxLength: number = MAX_UNTRUSTED_BLOCK_LENGTH): string {
  let result = text.slice(0, maxLength);
  result = result.normalize('NFKC');
  result = result.replace(ZERO_WIDTH_AND_CONTROL_PATTERN, '');
  result = replaceAllCaseInsensitive(result, boundary, '[redacted-boundary]');
  for (const label of BLOCK_LABELS) {
    result = neutralizeTagLike(result, label);
  }
  return result;
}

/**
 * Wraps one piece of untrusted content (a customer message, a retrieved
 * policy chunk, a tool result) in this request's boundary markers, after
 * running it through sanitizeUntrustedText above. The system instruction
 * (built elsewhere, never here) is what tells the model these tags
 * delimit data to read, never instructions to follow - this function's
 * only job is making sure the data itself can never forge that framing.
 */
export function buildUntrustedBlock(label: BlockLabel, text: string, boundary: string, maxLength: number = MAX_UNTRUSTED_BLOCK_LENGTH): string {
  const sanitized = sanitizeUntrustedText(text, boundary, maxLength);
  return `<${boundary}:${label}>\n${sanitized}\n</${boundary}:${label}>`;
}
