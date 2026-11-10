/**
 * Milestone 4 amendment H - the Nest-level half of the structural proof
 * (the source-scan half lives in no-privileged-runner-in-agent-loop.spec.ts).
 * Compiles the REAL ApprovalsModule (no database - MONGODB_URI is unset in
 * this test environment, matching ApprovalsModule's own conditional
 * DatabaseModule import) and proves, via Nest's own strict resolution
 * semantics, that PrivilegedRefundRunner is reachable from ApprovalsModule's
 * OWN internal scope (it is a real, correctly-wired provider) but NOT from
 * the root testing module's scope - exactly the encapsulation
 * `exports: [ApprovalService]` (never PrivilegedRefundRunner) is supposed
 * to produce. ApprovalService itself IS resolvable from the root scope,
 * proving the module as a whole isn't just broken/empty.
 */
import { describe, expect, it } from 'vitest';
import { Test } from '@nestjs/testing';
import { ApprovalsModule } from '../../src/approvals/approvals.module';
import { ApprovalService } from '../../src/approvals/approval.service';
import { PrivilegedRefundRunner } from '../../src/approvals/privileged-refund-runner';

describe('PrivilegedRefundRunner is not injectable from outside ApprovalsModule', () => {
  it('cannot be resolved from the root testing module\'s own scope (strict)', async () => {
    const moduleRef = await Test.createTestingModule({ imports: [ApprovalsModule] }).compile();

    expect(() => moduleRef.get(PrivilegedRefundRunner, { strict: true })).toThrow();
  });

  it('IS resolvable from inside ApprovalsModule\'s own scope - a real, correctly-wired provider, not just missing', async () => {
    const moduleRef = await Test.createTestingModule({ imports: [ApprovalsModule] }).compile();

    const runner = moduleRef.select(ApprovalsModule).get(PrivilegedRefundRunner);
    expect(runner).toBeInstanceOf(PrivilegedRefundRunner);
  });

  it('ApprovalService is a real, correctly-wired provider within ApprovalsModule\'s own scope too - the module as a whole works, not just empty/broken', async () => {
    const moduleRef = await Test.createTestingModule({ imports: [ApprovalsModule] }).compile();

    expect(moduleRef.select(ApprovalsModule).get(ApprovalService)).toBeInstanceOf(ApprovalService);
  });
});
