/**
 * Milestone 4 amendment H (and G3's extension of it) - the Nest-level half
 * of the structural proof (the source-scan half lives in
 * no-privileged-runner-in-agent-loop.e2e-spec.ts).
 *
 * A note on HOW this proof is built, because an earlier draft of this file
 * got it wrong in a way worth recording: `moduleRef.get(token, { strict:
 * true })` against a module that never actually injects `token` anywhere in
 * its own providers throws regardless of whether `token` is exported or
 * not - confirmed empirically (not assumed) against this project's own
 * `ApprovalsModule`, including for `APPROVAL_PROPOSAL_PORT` itself, which
 * IS exported. `strict: true` resolution is keyed off instance links Nest
 * only creates for a (module, token) pair that module actually resolved
 * via real constructor injection - not off the static import/export graph
 * alone. So a test built only on "strict get from an uninvolved module
 * throws" would pass identically whether or not the encapsulation actually
 * held, which is not a real proof of anything.
 *
 * The REAL proof, used throughout this file: construct a module that
 * ACTUALLY TRIES to inject the thing via a real constructor parameter
 * (`@Inject`/parameter type), exactly the way a genuine consumer would, and
 * check whether `.compile()` itself succeeds or throws
 * ("UnknownElementException" when the dependency can't be resolved through
 * any import/export chain). This is Nest's own real DI resolution path -
 * the same one a real `ChatService` constructor would go through in Stage
 * 5 - not a synthetic lookup API with its own separate quirks.
 */
import { describe, expect, it } from 'vitest';
import { Inject, Injectable, Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ApprovalsModule } from '../../src/approvals/approvals.module';
import { APPROVAL_PROPOSAL_PORT, ApprovalProposalPort } from '../../src/approvals/approval-proposal.port';
import { ApprovalService } from '../../src/approvals/approval.service';
import { PrivilegedRefundRunner } from '../../src/approvals/privileged-refund-runner';
import { ChatModule } from '../../src/chat/chat.module';
import { ChatService } from '../../src/chat/chat.service';

@Injectable()
class PortConsumer {
  constructor(@Inject(APPROVAL_PROPOSAL_PORT) public readonly port: ApprovalProposalPort) {}
}

@Module({ imports: [ApprovalsModule], providers: [PortConsumer] })
class GoodConsumerModule {}

@Injectable()
class RunnerConsumer {
  constructor(public readonly runner: PrivilegedRefundRunner) {}
}

@Module({ imports: [ApprovalsModule], providers: [RunnerConsumer] })
class BadRunnerConsumerModule {}

@Injectable()
class ServiceConsumer {
  constructor(public readonly service: ApprovalService) {}
}

@Module({ imports: [ApprovalsModule], providers: [ServiceConsumer] })
class BadServiceConsumerModule {}

describe('PrivilegedRefundRunner and ApprovalService are not injectable from outside ApprovalsModule', () => {
  it("PrivilegedRefundRunner IS resolvable from inside ApprovalsModule's own scope - a real, correctly-wired provider, not just missing", async () => {
    const moduleRef = await Test.createTestingModule({ imports: [ApprovalsModule] }).compile();

    const runner = moduleRef.select(ApprovalsModule).get(PrivilegedRefundRunner);
    expect(runner).toBeInstanceOf(PrivilegedRefundRunner);
  });

  it("ApprovalService is a real, correctly-wired provider within ApprovalsModule's own scope too - the module as a whole works, not just empty/broken", async () => {
    const moduleRef = await Test.createTestingModule({ imports: [ApprovalsModule] }).compile();

    expect(moduleRef.select(ApprovalsModule).get(ApprovalService)).toBeInstanceOf(ApprovalService);
  });

  // Amendment G3: the one thing a real consumer CAN depend on - a module that only imports
  // ApprovalsModule and constructor-injects APPROVAL_PROPOSAL_PORT compiles cleanly, and resolves
  // to the real underlying ApprovalService singleton (useExisting - still one object at runtime).
  it('a module that injects only APPROVAL_PROPOSAL_PORT compiles cleanly and gets the real ApprovalService instance', async () => {
    const moduleRef = await Test.createTestingModule({ imports: [GoodConsumerModule] }).compile();

    const consumer = moduleRef.select(GoodConsumerModule).get(PortConsumer);
    expect(consumer.port).toBeInstanceOf(ApprovalService);
  });

  // The real proof (see file header): a module that imports ApprovalsModule and tries to inject
  // PrivilegedRefundRunner DIRECTLY, via a genuine constructor parameter, fails to even compile -
  // Nest's own dependency-resolution error, not a synthetic lookup API's own quirk.
  it('a module that tries to inject PrivilegedRefundRunner directly fails to compile (never exported, amendment H)', async () => {
    await expect(Test.createTestingModule({ imports: [BadRunnerConsumerModule] }).compile()).rejects.toThrow(/PrivilegedRefundRunner/);
  });

  // Amendment G3's extension: ApprovalService itself - not just PrivilegedRefundRunner - is ALSO
  // absent from `exports` now. A would-be consumer that reaches for the whole class (to call
  // decide/getById/list, the admin-decision surface a chat-side caller has no business touching)
  // gets the same structural rejection as reaching for PrivilegedRefundRunner.
  it('a module that tries to inject ApprovalService directly (not the narrow port) fails to compile (amendment G3)', async () => {
    await expect(Test.createTestingModule({ imports: [BadServiceConsumerModule] }).compile()).rejects.toThrow(/ApprovalService/);
  });

  /**
   * Amendment G4's deferred case, now meaningful: Stage 5 wired ChatModule to actually import
   * ApprovalsModule (for ChatService's own APPROVAL_PROPOSAL_PORT injection) - before that wiring
   * existed, any "ChatModule can't resolve PrivilegedRefundRunner" test would have been vacuously
   * true (ChatModule didn't import ApprovalsModule AT ALL, so of course nothing from it was
   * reachable - that proves nothing about encapsulation specifically).
   *
   * Only ONE test below, deliberately - NOT a `.get(PrivilegedRefundRunner, { strict: true })`
   * (or ApprovalService) check against `moduleRef.select(ChatModule)`. Per this file's own header
   * finding, strict resolution only succeeds for a (module, token) pair the module's OWN
   * providers actually resolved via real injection - since nothing in the real ChatService ever
   * tries to inject PrivilegedRefundRunner or ApprovalService, such a check would throw
   * regardless of whether those are exported, exactly the vacuous pattern this file's header
   * already warns about. The REAL ChatModule-specific proof is simply this: ChatService's own
   * real constructor injection of APPROVAL_PROPOSAL_PORT resolves to a genuine ApprovalService
   * instance - proving the Stage 5 import is real, not a no-op - and the generic
   * BadRunnerConsumerModule/BadServiceConsumerModule tests above already prove, module-shape-
   * agnostically, that no consumer of ApprovalsModule (ChatModule-shaped or otherwise) can ever
   * get past the encapsulation by trying to inject either class directly.
   */
  it("ChatService itself resolves the real ApprovalService instance through APPROVAL_PROPOSAL_PORT, inside the real ChatModule - the import is genuinely wired, not vacuous", async () => {
    const moduleRef = await Test.createTestingModule({ imports: [ChatModule] }).compile();

    const chatService = moduleRef.select(ChatModule).get(ChatService) as unknown as { approvalProposalPort: ApprovalProposalPort };
    expect(chatService.approvalProposalPort).toBeInstanceOf(ApprovalService);
  });
});
