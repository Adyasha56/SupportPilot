import { describe, expect, it } from 'vitest';
import {
  buildToolRequestUrl,
  RequestTemplateError,
  substitutePathTemplate,
} from './request-template';

describe('substitutePathTemplate', () => {
  it('substitutes a single placeholder', () => {
    expect(substitutePathTemplate('/orders/{order_id}', { order_id: 'ORD-1001' })).toBe(
      '/orders/ORD-1001',
    );
  });

  it('ignores extra args not referenced by the template', () => {
    expect(
      substitutePathTemplate('/orders/{order_id}', { order_id: 'ORD-1001', amount: '10' }),
    ).toBe('/orders/ORD-1001');
  });

  it('throws when an arg required by the template is missing', () => {
    expect(() => substitutePathTemplate('/orders/{order_id}', {})).toThrow(RequestTemplateError);
  });

  it('URL-encodes the substituted value', () => {
    expect(substitutePathTemplate('/escalations/{summary}', { summary: 'a b/c' })).toBe(
      '/escalations/a%20b%2Fc',
    );
  });

  it('throws when a value is ".." even though encodeURIComponent would leave it unchanged', () => {
    expect(() => substitutePathTemplate('/orders/{order_id}', { order_id: '..' })).toThrow(
      /disallowed sequence/,
    );
  });

  it('throws when a value is a hostile path-traversal attempt', () => {
    expect(() => substitutePathTemplate('/orders/{order_id}', { order_id: '../x' })).toThrow(
      RequestTemplateError,
    );
  });

  it('throws when the static template itself contains //', () => {
    expect(() => substitutePathTemplate('//orders/{order_id}', { order_id: 'ORD-1001' })).toThrow(
      /disallowed sequence/,
    );
  });

  it('throws when the static template contains a query or fragment marker', () => {
    expect(() =>
      substitutePathTemplate('/orders/{order_id}?x=1', { order_id: 'ORD-1001' }),
    ).toThrow(/disallowed sequence/);
    expect(() =>
      substitutePathTemplate('/orders/{order_id}#frag', { order_id: 'ORD-1001' }),
    ).toThrow(/disallowed sequence/);
  });
});

describe('buildToolRequestUrl', () => {
  it('resolves a simple path against a baseUrl with no path prefix', () => {
    const url = buildToolRequestUrl('http://localhost:4100', '/orders/ORD-1001');
    expect(url.toString()).toBe('http://localhost:4100/orders/ORD-1001');
  });

  it('stays within a baseUrl that has its own path prefix', () => {
    const url = buildToolRequestUrl('http://localhost:4100/api/v1', '/api/v1/orders/ORD-1001');
    expect(url.pathname).toBe('/api/v1/orders/ORD-1001');
  });

  it('rejects a path that resolves to a different origin, independent of substitutePathTemplate', () => {
    expect(() => buildToolRequestUrl('http://localhost:4100', 'http://evil.example/steal')).toThrow(
      /origin/,
    );
  });

  it('rejects a path that escapes the baseUrl path prefix', () => {
    expect(() => buildToolRequestUrl('http://localhost:4100/api/v1', '/other')).toThrow(
      /escapes the connector baseUrl path/,
    );
  });
});
