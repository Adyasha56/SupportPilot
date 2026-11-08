import { describe, expect, it, vi } from 'vitest';
import {
  buildRegisterCommand,
  keyFilePathFor,
  parseArgs,
  requireCustomerRef,
  requireTenantId,
  resolveKeyDir,
  resolveKid,
  resolveLifetimeMs,
} from './mint-customer-token';
import { CUSTOMER_TOKEN_MAX_LIFETIME_MS } from '../src/agent/identity/customer-token';

describe('parseArgs', () => {
  it('parses --key=value pairs and bare --flags', () => {
    expect(parseArgs(['--tenantId=acme', '--kid=2', '--allow-test-db'])).toEqual({
      tenantId: 'acme',
      kid: '2',
      'allow-test-db': true,
    });
  });

  it('ignores non-flag arguments', () => {
    expect(parseArgs(['node', 'script.js', '--tenantId=acme'])).toEqual({ tenantId: 'acme' });
  });
});

describe('requireTenantId', () => {
  it('accepts a valid tenant id', () => {
    expect(requireTenantId({ tenantId: 'acme' })).toBe('acme');
  });

  it('rejects a missing tenantId', () => {
    expect(() => requireTenantId({})).toThrow(/--tenantId is required/);
  });

  it('rejects a tenantId that does not match TENANT_ID_PATTERN', () => {
    expect(() => requireTenantId({ tenantId: 'Not Valid!' })).toThrow(/--tenantId is required/);
  });
});

describe('requireCustomerRef', () => {
  it('accepts a valid customerRef', () => {
    expect(requireCustomerRef({ customerRef: 'cust_1' })).toBe('cust_1');
  });

  it('rejects a missing customerRef', () => {
    expect(() => requireCustomerRef({})).toThrow(/--customerRef is required/);
  });

  it('rejects a customerRef with disallowed characters', () => {
    expect(() => requireCustomerRef({ customerRef: 'has a space' })).toThrow(/--customerRef is required/);
  });
});

describe('resolveKid', () => {
  it('defaults to 1 when --kid is omitted', () => {
    expect(resolveKid({})).toBe(1);
  });

  it('parses a valid non-negative integer', () => {
    expect(resolveKid({ kid: '7' })).toBe(7);
  });

  it('rejects a negative kid', () => {
    expect(() => resolveKid({ kid: '-1' })).toThrow(/--kid must be a non-negative integer/);
  });

  it('rejects a non-integer kid', () => {
    expect(() => resolveKid({ kid: '1.5' })).toThrow(/--kid must be a non-negative integer/);
  });
});

describe('resolveLifetimeMs', () => {
  it('defaults to 5 minutes when --lifetimeMs is omitted, no warning', () => {
    const warn = vi.fn();
    expect(resolveLifetimeMs({}, warn)).toBe(5 * 60 * 1000);
    expect(warn).not.toHaveBeenCalled();
  });

  it('accepts an explicit lifetime within the server max, no warning', () => {
    const warn = vi.fn();
    expect(resolveLifetimeMs({ lifetimeMs: '60000' }, warn)).toBe(60_000);
    expect(warn).not.toHaveBeenCalled();
  });

  it('warns (but still returns the value) when the lifetime exceeds CUSTOMER_TOKEN_MAX_LIFETIME_MS', () => {
    const warn = vi.fn();
    const tooLong = CUSTOMER_TOKEN_MAX_LIFETIME_MS + 1;
    expect(resolveLifetimeMs({ lifetimeMs: String(tooLong) }, warn)).toBe(tooLong);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain('EXPIRY_TOO_FAR');
  });

  it('rejects a zero or negative lifetime', () => {
    const warn = vi.fn();
    expect(() => resolveLifetimeMs({ lifetimeMs: '0' }, warn)).toThrow(/--lifetimeMs must be a positive number/);
  });
});

describe('resolveKeyDir', () => {
  it('resolves a relative path to an absolute one', () => {
    expect(resolveKeyDir('./.customer-keys')).toMatch(/[\\/]\.customer-keys$/);
  });

  it('rejects an empty value', () => {
    expect(() => resolveKeyDir('  ')).toThrow(/must not be empty/);
  });
});

describe('keyFilePathFor', () => {
  it('builds a fixed-shape filename from tenantId and kid', () => {
    const path = keyFilePathFor('./.customer-keys', 'acme', 2);
    expect(path.endsWith('acme.2.json') || path.endsWith('acme.2.json'.replace('/', '\\'))).toBe(true);
  });
});

describe('buildRegisterCommand', () => {
  it('prints the exact register-customer-key invocation', () => {
    expect(buildRegisterCommand('acme', 2, 'abc123')).toBe('pnpm run register-customer-key -- --tenantId=acme --kid=2 --publicKeyX=abc123');
  });
});
