import { Injectable } from '@nestjs/common';

/**
 * In-memory, single-process - same caveat as apps/api/src/auth's
 * FailedAttemptLimiter: fine at this project's scale (one instance, free
 * tier); would need a shared store (e.g. Redis) to enforce "one concurrent
 * ingestion per tenant" across multiple instances.
 */
@Injectable()
export class TenantIngestionLock {
  private readonly busyTenants = new Set<string>();

  tryAcquire(tenantId: string): boolean {
    if (this.busyTenants.has(tenantId)) {
      return false;
    }
    this.busyTenants.add(tenantId);
    return true;
  }

  release(tenantId: string): void {
    this.busyTenants.delete(tenantId);
  }
}
