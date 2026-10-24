const FORBIDDEN_SEGMENTS = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * Resolves a simple "$.field.nested" dot-path against a response object.
 * Refuses to traverse __proto__/constructor/prototype segments, even though
 * today's paths only ever come from trusted connector config.
 */
export function resolvePath(obj: unknown, path: string): unknown {
  if (!path.startsWith('$.')) {
    throw new Error(`Unsupported path expression: ${path}`);
  }

  const segments = path.slice(2).split('.');
  let current: unknown = obj;

  for (const segment of segments) {
    if (FORBIDDEN_SEGMENTS.has(segment)) {
      return undefined;
    }
    if (current === null || typeof current !== 'object') {
      return undefined;
    }
    current = (current as Record<string, unknown>)[segment];
  }

  return current;
}
