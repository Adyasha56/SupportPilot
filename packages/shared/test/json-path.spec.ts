import { describe, expect, it } from 'vitest';
import { resolvePath } from '../src/json-path';

describe('resolvePath', () => {
  it('resolves a simple field', () => {
    expect(resolvePath({ status: 'delivered' }, '$.status')).toBe('delivered');
  });

  it('resolves a nested field', () => {
    expect(resolvePath({ order: { total: 49.99 } }, '$.order.total')).toBe(49.99);
  });

  it('returns undefined for a missing field', () => {
    expect(resolvePath({ status: 'ok' }, '$.missing')).toBeUndefined();
  });

  it('returns undefined when traversing through null or a primitive', () => {
    expect(resolvePath({ order: null }, '$.order.total')).toBeUndefined();
    expect(resolvePath({ order: 5 }, '$.order.total')).toBeUndefined();
  });

  it('throws on a path that does not start with $.', () => {
    expect(() => resolvePath({}, 'status')).toThrow();
  });

  it('refuses to traverse __proto__, constructor, or prototype segments', () => {
    const malicious = JSON.parse('{"__proto__": {"polluted": true}}') as object;
    expect(resolvePath(malicious, '$.__proto__.polluted')).toBeUndefined();
    expect(resolvePath({}, '$.constructor.prototype')).toBeUndefined();
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});
