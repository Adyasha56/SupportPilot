/**
 * Quota (DOCUMENT_QUOTA_EXCEEDED, CHUNK_QUOTA_EXCEEDED) and concurrency
 * (TENANT_BUSY) checks against the real database. Two separate app
 * instances, each with its own env override, so neither test's setup
 * interferes with the other's:
 *  - quotaApp: INGESTION_MAX_DOCUMENTS_PER_TENANT / INGESTION_MAX_CHUNKS_PER_TENANT
 *    forced small, so a quota can actually be hit without uploading
 *    dozens of real documents.
 *  - gatedApp: LLM_PROVIDER overridden with a provider whose embed() call
 *    blocks on a manually-released gate, so the TENANT_BUSY race is
 *    deterministic - no sleep, no timing guess. The lock is acquired
 *    BEFORE embedding happens (see ingestion.ts's ingest()), so holding
 *    embed() open holds the lock open.
 */
import './test-env';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AppModule } from '../../src/app.module';
import { LLM_PROVIDER } from '../../src/llm/llm.module';
import { EmbedOutcome, EmbeddingTaskType, LlmProvider } from '../../src/llm/llm-provider.interface';
import { FakeLlmProvider } from '../../src/llm/test-utils/fake-llm-provider';
import { cleanupTenant, createTenantFixture, disconnectFixtureConnection } from './tenant-fixture';
import { getTestMongoUri, integrationTestsEnabled } from './test-env';

class GatedLlmProvider implements LlmProvider {
  private readonly inner = new FakeLlmProvider();
  private releaseGate: (() => void) | undefined;
  private gatePromise: Promise<void> | undefined;
  private resolveEntered: (() => void) | undefined;
  private enteredPromise: Promise<void> | undefined;
  private held = false;
  /** Proves this instance - not some other provider - is really the one the ingestion path calls (see the sanity check below). */
  callCount = 0;

  /** Call BEFORE the request that should block - sets up a gate embed() will wait on. */
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

  /** Resolves the instant embed() is actually called and gated - an explicit signal from the provider itself, never a timing guess. */
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
    this.callCount += 1;
    if (this.gatePromise) {
      this.resolveEntered?.();
      await this.gatePromise;
    }
    return this.inner.embed(texts, taskType);
  }
}

/**
 * Every wait in the TENANT_BUSY test below goes through this - no wait is
 * ever allowed to hang for the full test timeout (90s) silently again, the
 * way it did twice before (once with a setImmediate timing guess, once
 * because the request it was waiting on was never actually sent - see this
 * file's own history). A timeout here fails fast, at a bounded, known cost,
 * with the state that would otherwise only be visible by reading supertest
 * internals mid-hang.
 */
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

describe.skipIf(!integrationTestsEnabled())('Quota limits (integration, real database)', () => {
  let app: INestApplication;
  const uri = integrationTestsEnabled() ? getTestMongoUri() : '';
  const createdTenants: string[] = [];

  beforeAll(async () => {
    process.env.INGESTION_MAX_DOCUMENTS_PER_TENANT = '1';
    process.env.INGESTION_MAX_CHUNKS_PER_TENANT = '3';

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(LLM_PROVIDER)
      .useClass(FakeLlmProvider)
      .compile();
    app = moduleRef.createNestApplication();
    await app.init();
  }, 150_000);

  afterAll(async () => {
    delete process.env.INGESTION_MAX_DOCUMENTS_PER_TENANT;
    delete process.env.INGESTION_MAX_CHUNKS_PER_TENANT;
    await Promise.all(createdTenants.map((tenantId) => cleanupTenant(uri, tenantId)));
    await app.close();
    await disconnectFixtureConnection();
  });

  it('rejects a second document with 422 DOCUMENT_QUOTA_EXCEEDED once the per-tenant document cap (1) is reached', async () => {
    const tenant = await createTenantFixture(uri);
    createdTenants.push(tenant.tenantId);

    const first = await request(app.getHttpServer())
      .post('/v1/policies')
      .set('Authorization', `Bearer ${tenant.secretKey}`)
      .attach('file', Buffer.from('# First\n\nFirst document body.'), 'first.md');
    expect(first.status).toBe(201);

    const second = await request(app.getHttpServer())
      .post('/v1/policies')
      .set('Authorization', `Bearer ${tenant.secretKey}`)
      .attach('file', Buffer.from('# Second\n\nA completely different second document body.'), 'second.md');
    expect(second.status).toBe(422);
    expect(second.body.code).toBe('DOCUMENT_QUOTA_EXCEEDED');
  });

  it('rejects a document whose chunks would exceed the per-tenant chunk cap (3) with 422 CHUNK_QUOTA_EXCEEDED', async () => {
    const tenant = await createTenantFixture(uri);
    createdTenants.push(tenant.tenantId);

    // Four headings -> four chunks -> exceeds the chunk cap of 3 on the
    // very first (and, per the document cap above being separate per
    // tenant, only) upload. Each section's body must be well over ~400
    // characters (the chunker's default 100-token merge floor - see
    // markdown-chunker.ts's mergeTinySections) or same-parent sections get
    // merged into one chunk and the cap is never actually exceeded - a
    // short one-line body here, like the ones this file originally used,
    // produces exactly 1 merged chunk, not 4 (confirmed by reading
    // mergeTinySections directly, not assumed).
    const longBody = (label: string): string =>
      `${label} body text with enough unique content of its own that this section stays distinct from its siblings during chunking and is never merged with them. `.repeat(
        4,
      );
    const markdown = ['One', 'Two', 'Three', 'Four'].map((label) => `# ${label}\n\n${longBody(label)}`).join('\n\n');
    const res = await request(app.getHttpServer())
      .post('/v1/policies')
      .set('Authorization', `Bearer ${tenant.secretKey}`)
      .attach('file', Buffer.from(markdown), 'four-sections.md');

    expect(res.status).toBe(422);
    expect(res.body.code).toBe('CHUNK_QUOTA_EXCEEDED');
  });
});

describe.skipIf(!integrationTestsEnabled())('Concurrency limit: one ingestion per tenant (integration, real database)', () => {
  let app: INestApplication;
  let close: () => Promise<void>;
  let gatedProvider: GatedLlmProvider;
  const uri = integrationTestsEnabled() ? getTestMongoUri() : '';
  const createdTenants: string[] = [];

  beforeAll(async () => {
    gatedProvider = new GatedLlmProvider();
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(LLM_PROVIDER)
      .useValue(gatedProvider)
      .compile();
    app = moduleRef.createNestApplication();
    await app.init();
    close = () => app.close();
  }, 150_000);

  afterAll(async () => {
    await Promise.all(createdTenants.map((tenantId) => cleanupTenant(uri, tenantId)));
    await close();
    await disconnectFixtureConnection();
  });

  it('returns 429 TENANT_BUSY for a second concurrent upload while the first is still embedding', async () => {
    const tenant = await createTenantFixture(uri);
    createdTenants.push(tenant.tenantId);
    const nonce = `${Date.now()}-${Math.random().toString(36).slice(2)}`;

    // --- Sanity check first (diagnosed, not assumed): prove the override
    // wiring actually routes a real upload's embed() calls through THIS
    // provider instance, before testing anything about gating at all. A
    // mismatch here would misdirect every assertion below at a wiring bug
    // dressed up as a concurrency bug.
    const wiringCheck = await request(app.getHttpServer())
      .post('/v1/policies')
      .set('Authorization', `Bearer ${tenant.secretKey}`)
      .attach('file', Buffer.from(`# Wiring check ${nonce}\n\nConfirms GatedLlmProvider is the real provider in use.`), 'wiring-check.md');
    expect(wiringCheck.status, `wiring check upload failed: ${JSON.stringify(wiringCheck.body)}`).toBe(201);
    expect(gatedProvider.callCount, 'GatedLlmProvider.embed() was not called exactly once for a normal upload - wrong provider is wired in').toBe(1);

    gatedProvider.hold();

    // Dispatched IMMEDIATELY by calling .then() directly on the supertest
    // chain, not left as a bare superagent Test object. A superagent Test
    // is a thenable that only actually sends the HTTP request the first
    // time something calls .then()/.end() on it (confirmed directly in
    // superagent's own source, lib/request-base.js:
    // RequestBase.prototype.then constructs `this._fullfilledPromise` via
    // `new Promise((resolve, reject) => { ...; self.end(...); })` - a
    // Promise executor runs SYNCHRONOUSLY the moment `new Promise(...)` is
    // called, so `self.end()` - the thing that actually sends the request -
    // fires synchronously, inside this `.then()` call, at this exact line.
    // Wrapping in Promise.resolve() instead (a previous version of this
    // fix) does NOT do this: resolving a promise with a thenable value is
    // its own spec'd procedure (PromiseResolveThenableJob) that schedules a
    // MICROTASK to call the thenable's .then() later, not synchronously -
    // so Promise.resolve() would have deferred the actual dispatch by at
    // least one microtask tick instead of firing it at this line. The
    // previous version of this test (neither form) built this request and
    // only ever awaited it at the very end, AFTER already waiting on a
    // signal (embed() being entered) that only the server receiving this
    // exact request could ever produce - a self-deadlock, not a
    // server-side hang.
    /** A one-line, always-safe-to-print summary of request 1's state - undefined means "no response yet", never throws. */
    let describeFirst = (): string => 'not yet settled';
    const firstRequest = request(app.getHttpServer())
      .post('/v1/policies')
      .set('Authorization', `Bearer ${tenant.secretKey}`)
      .attach('file', Buffer.from(`# Held ${nonce}\n\nThis upload is held open by the gate.`), 'held.md')
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
    let second: { status: number; body: { code?: string } } | undefined;
    try {
      await withBoundedWait(
        gatedProvider.waitUntilEntered(),
        WAIT_MS,
        () => `embed() being entered for request 1 - gate held: ${gatedProvider.isHeld()}, request 1: ${describeFirst()}`,
      );

      second = await withBoundedWait(
        request(app.getHttpServer())
          .post('/v1/policies')
          .set('Authorization', `Bearer ${tenant.secretKey}`)
          .attach('file', Buffer.from(`# Second ${nonce}\n\nThis upload must be rejected as busy.`), 'second.md'),
        WAIT_MS,
        () => `request 2's response - request 1: ${describeFirst()}`,
      );
    } finally {
      // Deliberately no assertion in here - a throwing assertion inside a
      // finally block would mask whatever the try block itself failed
      // with. This block's only job is to guarantee cleanup can never be
      // skipped: release the gate and drain request 1, even if an
      // assertion above already failed - otherwise request 1's handler
      // stays suspended forever inside embed(), keeping an HTTP connection
      // open and hanging this file's own afterAll (app.close() waiting for
      // in-flight connections to finish) the same way a previous version
      // of this test did.
      gatedProvider.release();
      await withBoundedWait(firstRequest, WAIT_MS, () => 'request 1 to finish after releasing the gate');
    }

    expect(second?.status, `expected 429, got ${JSON.stringify(second)}`).toBe(429);
    expect(second?.body.code).toBe('TENANT_BUSY');

    // firstRequest is already settled by this point (awaited inside the
    // finally block above) - re-awaiting a settled promise just returns
    // its cached value, no new network round trip.
    const first = await firstRequest;
    expect(first.status, `expected request 1 to succeed with 201, got ${first.status}: ${JSON.stringify(first.body)}`).toBe(201);
  });
});
