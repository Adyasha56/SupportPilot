export class RequestTemplateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RequestTemplateError';
  }
}

const PLACEHOLDER_PATTERN = /\{([a-zA-Z0-9_]+)\}/g;
const DISALLOWED_SUBSTRINGS = ['//', '\\', '..', '?', '#'];

/**
 * Substitutes {placeholder} tokens in a connector's path template with
 * validated, encodeURIComponent-encoded arg values.
 *
 * No query parameters this milestone: none of the 4 MVP tools need them
 * (path placeholders cover get_order/track_shipment; issue_refund and
 * escalate_to_human send their args in the POST body, built separately by
 * the tool runner). A literal "?" anywhere in the result is rejected below,
 * so this isn't an oversight - query-string support is deliberately out of
 * scope until a tool actually needs it.
 */
export function substitutePathTemplate(pathTemplate: string, args: Record<string, string>): string {
  const placeholders = [...pathTemplate.matchAll(PLACEHOLDER_PATTERN)].map((match) => match[1]);

  for (const name of placeholders) {
    if (!(name in args)) {
      throw new RequestTemplateError(`Missing argument for path placeholder: ${name}`);
    }
  }

  const substituted = pathTemplate.replace(PLACEHOLDER_PATTERN, (_match, name: string) =>
    encodeURIComponent(args[name]),
  );

  // Checked post-substitution, not just on the raw template: encodeURIComponent
  // leaves "." untouched, so a malicious arg value of ".." would otherwise
  // survive encoding and only be caught here.
  for (const disallowed of DISALLOWED_SUBSTRINGS) {
    if (substituted.includes(disallowed)) {
      throw new RequestTemplateError(`Resolved path contains disallowed sequence: ${disallowed}`);
    }
  }

  return substituted;
}

/**
 * Resolves the substituted path against the connector's baseUrl and verifies
 * the result didn't escape it - independent of the substring check above,
 * since catching the same class of bug two different ways is worth the few
 * extra lines.
 */
export function buildToolRequestUrl(baseUrl: string, substitutedPath: string): URL {
  const base = new URL(baseUrl);
  const resolved = new URL(substitutedPath, base);

  if (resolved.origin !== base.origin) {
    throw new RequestTemplateError('Resolved URL origin does not match the connector baseUrl');
  }

  const basePathWithSlash = base.pathname.endsWith('/') ? base.pathname : `${base.pathname}/`;
  if (resolved.pathname !== base.pathname && !resolved.pathname.startsWith(basePathWithSlash)) {
    throw new RequestTemplateError('Resolved URL path escapes the connector baseUrl path');
  }

  return resolved;
}
