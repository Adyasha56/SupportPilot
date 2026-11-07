/**
 * Stage 6 - the same-conversation concurrency case: a second request for a
 * conversation already being processed must get 409 CONVERSATION_BUSY, and
 * the lock must be free again once the first request finishes (including
 * via its `finally`, so a slow or erroring first request never wedges a
 * conversation shut forever).
 *
 * Needs a GATED provider, not a plain script - the whole point is to hold
 * the first request open deterministically (no sleep, no timing guess)
 * while the second one is sent, then release it - same reasoning and the
 * same `.then()`-dispatch / withBoundedWait pattern
 * quota-and-concurrency.integration-spec.ts's own TENANT_BUSY test already
 * established, just gating runAgent's generate() calls instead of
 * ingestion's embed() call.
 */
import './test-env';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ComposeOutput, PlannerOutput } from '@supportpilot/shared';
import { AppModule } from '../../src/app.module';
import { LLM_PROVIDER } from '../../src/llm/llm.module';
import { EmbedOutcome, EmbeddingTaskType, GenerateOptions, GenerateOutcome, LlmProvider } from '../../src/llm/llm-provider.interface';
import { FakeLlmProvider } from '../../src/llm/test-utils/fake-llm-provider';
import { CONVERSATION_REPOSITORY, ConversationRepository } from '../../src/db/conversation.repository';
import { cleanupTenant, createTenantFixture, disconnectFixtureConnection } from './tenant-fixture';
import { getTestMongoUri, integrationTestsEnabled } from './test-env';

function planOutput(overrides: Partial<PlannerOutput> = {}): GenerateOutcome {
  const data: PlannerOutput = { reasoning: 'thinking', needsPolicy: false, toolRequests: [], ...overrides };
  return { ok: true, result: { text: JSON.stringify(data), usage: { inputTokens: 10, outputTokens: 10 } } };
}

function composeOutput(overrides: Partial<ComposeOutput> = {}): GenerateOutcome {
  const data: ComposeOutput = { outcome: 'clarify', message: 'ok', citedChunkKeys: [], ...overrides };
  return { ok: true, result: { text: JSON.stringify(data), usage: { inputTokens: 10, outputTokens: 10 } } };
}

/** Mirrors quota-and-concurrency.integration-spec.ts's own GatedLlmProvider exactly, gating generate() (runAgent's plan/compose calls) instead of embed() (ingestion's chunk-embedding call). */
class GatedLlmProvider implements LlmProvider {
  private readonly inner: FakeLlmProvider;
  private releaseGate: (() => void) | undefined;
  private gatePromise: Promise<void> | undefined;
  private resolveEntered: (() => void) | undefined;
  private enteredPromise: Promise<void> | undefined;
  private held = false;
  callCount = 0;

  constructor(script: GenerateOutcome[]) {
    this.inner = new FakeLlmProvider(script);
  }

  hold(): void {
    this.held = true;
    this.gatePromise = new Promise((resolve) => {
      this.releaseGate = resolve;
    });
    this.enteredPromise = new Promise((resolve) => {
      this.resolveEntered = resolve;
    });
  }

  isHeld(): boolean {
    return this.held;
  }

  waitUntilEntered(): Promise<void> {
    if (!this.enteredPromise) {
      throw new Error('hold() must be called before waitUntilEntered()');
    }
    return this.enteredPromise;
  }

  release(): void {
    this.held = false;
    this.releaseGate?.();
  }

  async embed(texts: string[], taskType: EmbeddingTaskType): Promise<EmbedOutcome> {
    return this.inner.embed(texts, taskType);
  }

  async generate(options: GenerateOptions): Promise<GenerateOutcome> {
    this.callCount += 1;
    if (this.gatePromise) {
      this.resolveEntered?.();
      await this.gatePromise;
    }
    return this.inner.generate(options);
  }
}

async function withBoundedWait<T>(promise: Promise<T>, ms: number, describeState: () => string): Promise<T> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Timed out after ${ms}ms waiting for: ${describeState()}`)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer!);
  }
}

describe.skipIf(!integrationTestsEnabled())('Chat conversation lock concurrency (integration, real database)', () => {
  let app: INestApplication;
  let close: () => Promise<void>;
  const uri = integrationTestsEnabled() ? getTestMongoUri() : '';
  const createdTenants: string[] = [];
  let gatedProvider: GatedLlmProvider;

  beforeAll(async () => {
    // 3 full turns' worth of calls (2 generate() calls each): the wiring
    // check, the held request, and the final "lock is free again" request.
    // The rejected (409) second request never reaches generate() at all, so
    // it consumes none of this script.
    gatedProvider = new GatedLlmProvider([
      planOutput(),
      composeOutput({ outcome: 'clarify', message: 'wiring check reply' }),
      planOutput(),
      composeOutput({ outcome: 'clarify', message: 'first reply' }),
      planOutput(),
      composeOutput({ outcome: 'clarify', message: 'third reply' }),
    ]);
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).overrideProvider(LLM_PROVIDER).useValue(gatedProvider).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    close = () => app.close();
  }, 150_000);

  afterAll(async () => {
    await Promise.all(createdTenants.map((tenantId) => cleanupTenant(uri, tenantId)));
    await close();
    await disconnectFixtureConnection();
  });

  it('a second request for the SAME conversation gets 409 CONVERSATION_BUSY while the first is still mid-run; the lock is free again afterward', async () => {
    const tenant = await createTenantFixture(uri);
    createdTenants.push(tenant.tenantId);

    const conversationRepository = app.get<ConversationRepository>(CONVERSATION_REPOSITORY);
    const conversation = await conversationRepository.create(tenant.tenantId, null);

    // --- Sanity check first (diagnosed, not assumed, same reasoning as the
    // ingestion TENANT_BUSY test's own wiring check): prove this provider
    // instance really is the one wired into runAgent before testing
    // anything about gating.
    gatedProvider.callCount = 0;
    const wiringCheck = await request(app.getHttpServer())
      .post('/v1/chat')
      .set('Authorization', `Bearer ${tenant.publicKey}`)
      .send({ message: 'wiring check', conversationId: conversation.id });
    expect(wiringCheck.status, `wiring check failed: ${JSON.stringify(wiringCheck.body)}`).toBe(200);
    expect(gatedProvider.callCount, 'GatedLlmProvider.generate() was not called - wrong provider wired in').toBe(2);

    gatedProvider.callCount = 0;
    gatedProvider.hold();

    let describeFirst = (): string => 'not yet settled';
    const firstRequest = request(app.getHttpServer())
      .post('/v1/chat')
      .set('Authorization', `Bearer ${tenant.publicKey}`)
      .send({ message: 'held request', conversationId: conversation.id })
      .then((res) => res);
    firstRequest.then(
      (res) => {
        describeFirst = () => `status ${res.status}, body ${JSON.stringify(res.body)}`;
      },
      (err) => {
        describeFirst = () => `rejected: ${err instanceof Error ? err.message : String(err)}`;
      },
    );

    const WAIT_MS = 10_000;
    try {
      await withBoundedWait(
        gatedProvider.waitUntilEntered(),
        WAIT_MS,
        () => `generate() being entered for request 1 - gate held: ${gatedProvider.isHeld()}, request 1: ${describeFirst()}`,
      );

      const second = await withBoundedWait(
        request(app.getHttpServer())
          .post('/v1/chat')
          .set('Authorization', `Bearer ${tenant.publicKey}`)
          .send({ message: 'should be rejected as busy', conversationId: conversation.id }),
        WAIT_MS,
        () => `request 2's response - request 1: ${describeFirst()}`,
      );

      expect(second.status).toBe(409);
      expect(second.body).toMatchObject({ code: 'CONVERSATION_BUSY' });
    } finally {
      gatedProvider.release();
    }

    const first = await withBoundedWait(firstRequest, WAIT_MS, () => `request 1 draining - ${describeFirst()}`);
    expect(first.status, `request 1 should have completed normally once released: ${describeFirst()}`).toBe(200);

    // The lock is free again: a third request for the same conversation,
    // sent AFTER request 1 has fully finished, must succeed normally.
    gatedProvider.release(); // idempotent - no-op if already released by the finally above.
    const third = await request(app.getHttpServer())
      .post('/v1/chat')
      .set('Authorization', `Bearer ${tenant.publicKey}`)
      .send({ message: 'lock should be free now', conversationId: conversation.id });
    expect(third.status, `the lock should be free after request 1 completed: ${JSON.stringify(third.body)}`).toBe(200);
  });
});
