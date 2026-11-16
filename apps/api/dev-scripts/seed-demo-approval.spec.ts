import { describe, expect, it } from 'vitest';
import {
  generateDemoRunId,
  parseArgs,
  refuseProductionEnv,
  requireAmount,
  requireChunkKey,
  requireCustomerRef,
  requireOrderId,
  requireTenantId,
} from './seed-demo-approval';

describe('parseArgs', () => {
  it('parses --key=value pairs and bare --flags', () => {
    expect(parseArgs(['--tenantId=acme', '--amount=49.99', '--allow-test-db'])).toEqual({
      tenantId: 'acme',
      amount: '49.99',
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

  it('rejects a tenantId that does not match the shared pattern', () => {
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

describe('requireOrderId', () => {
  it('accepts a valid order id', () => {
    expect(requireOrderId({ orderId: 'ORD-1001' })).toBe('ORD-1001');
  });

  it('rejects a missing orderId', () => {
    expect(() => requireOrderId({})).toThrow(/--orderId is required/);
  });

  it('rejects an orderId with disallowed characters', () => {
    expect(() => requireOrderId({ orderId: 'ORD 1001' })).toThrow(/--orderId is required/);
  });
});

describe('requireChunkKey', () => {
  it('accepts a valid chunk key', () => {
    expect(requireChunkKey({ chunkKey: 'd1-0' })).toBe('d1-0');
  });

  it('rejects a missing chunkKey, with guidance toward a real one', () => {
    expect(() => requireChunkKey({})).toThrow(/--chunkKey is required.*already-uploaded policy document/);
  });

  it('rejects a chunkKey with disallowed characters', () => {
    expect(() => requireChunkKey({ chunkKey: 'not a key!' })).toThrow(/--chunkKey is required/);
  });
});

describe('requireAmount', () => {
  it('converts a valid dollar amount to both dollars and cents', () => {
    expect(requireAmount({ amount: '49.99' })).toEqual({ dollars: 49.99, cents: 4999 });
  });

  it('handles a whole-dollar amount with no decimal part', () => {
    expect(requireAmount({ amount: '10' })).toEqual({ dollars: 10, cents: 1000 });
  });

  it('rejects a missing amount', () => {
    expect(() => requireAmount({})).toThrow(/--amount is required/);
  });

  it('rejects a zero amount', () => {
    expect(() => requireAmount({ amount: '0' })).toThrow(/--amount must be a positive number/);
  });

  it('rejects a negative amount', () => {
    expect(() => requireAmount({ amount: '-5' })).toThrow(/--amount must be a positive number/);
  });

  it('rejects a non-numeric amount', () => {
    expect(() => requireAmount({ amount: 'not-a-number' })).toThrow(/--amount must be a positive number/);
  });
});

describe('refuseProductionEnv', () => {
  it('throws when NODE_ENV=production, with no bypass flag of any kind', () => {
    expect(() => refuseProductionEnv({ NODE_ENV: 'production' })).toThrow(/Refusing to run: NODE_ENV=production/);
  });

  it('allows development', () => {
    expect(() => refuseProductionEnv({ NODE_ENV: 'development' })).not.toThrow();
  });

  it('allows test', () => {
    expect(() => refuseProductionEnv({ NODE_ENV: 'test' })).not.toThrow();
  });

  it('allows an unset NODE_ENV', () => {
    expect(() => refuseProductionEnv({})).not.toThrow();
  });
});

describe('generateDemoRunId', () => {
  it('is always prefixed demo_seed_ - never mistakable for a real chat-generated runId', () => {
    expect(generateDemoRunId()).toMatch(/^demo_seed_/);
  });

  it('is different on every call', () => {
    expect(generateDemoRunId()).not.toBe(generateDemoRunId());
  });
});
