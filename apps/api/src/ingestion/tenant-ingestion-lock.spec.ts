import { describe, expect, it } from 'vitest';
import { TenantIngestionLock } from './tenant-ingestion-lock';

describe('TenantIngestionLock', () => {
  it('allows the first acquire for a tenant and blocks a concurrent second one', () => {
    const lock = new TenantIngestionLock();
    expect(lock.tryAcquire('acme')).toBe(true);
    expect(lock.tryAcquire('acme')).toBe(false);
  });

  it('is scoped per tenant - a different tenant is never blocked by another tenant\'s ingestion', () => {
    const lock = new TenantIngestionLock();
    expect(lock.tryAcquire('acme')).toBe(true);
    expect(lock.tryAcquire('widgetco')).toBe(true);
  });

  it('release frees the tenant up for a new acquire', () => {
    const lock = new TenantIngestionLock();
    lock.tryAcquire('acme');
    lock.release('acme');
    expect(lock.tryAcquire('acme')).toBe(true);
  });
});
