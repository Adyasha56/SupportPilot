/**
 * Milestone 4 Stage 3 - Approval persistence only, against the REAL test
 * database (no AppModule, no ApprovalsModule DI wiring yet - that's a
 * later stage). Uses the shared default mongoose connection the same way
 * tenant-fixture.ts's own helpers do, and constructs MongooseApprovalRepository
 * directly from a real connected model, exactly like create-api-key.ts/
 * mint-customer-token.ts already do for their own repositories outside
 * Nest's DI container.
 *
 * What only CI can prove (recorded here, not just asserted): that Atlas
 * Local genuinely supports a partial unique index with a plain equality
 * filter ({ active: true }) on a brand-new collection, and that two
 * REAL concurrent findOneAndUpdate calls against it resolve to exactly one
 * winner under real network/driver conditions - a single-threaded
 * in-memory fake's "one call completes before the next starts" can
 * simulate the OUTCOME of a lost race, but it cannot prove the database
 * itself serializes two genuinely concurrent writes correctly. This file
 * is written to run there; locally, without MONGODB_TEST_URI, it reports
 * as skipped, not passed.
 */
import './test-env';
import { describe, expect, it, afterAll } from 'vitest';
import mongoose, { Model, Types } from 'mongoose';
import { cleanupTenant, disconnectFixtureConnection, randomTenantId } from './tenant-fixture';
import { getTestMongoUri, integrationTestsEnabled } from './test-env';
import { ApprovalDocument, ApprovalSchema } from '../../src/approvals/schemas/approval.schema';
import { MongooseApprovalRepository, NewApproval } from '../../src/approvals/approval.repository';

// Explicit <ApprovalDocument> type argument (not left to inference) - same reasoning as
// set-tenant-settings.ts's own comment: feeding mongoose.model()'s own precise inferred return
// type into a constructor parameter annotated as the plainer Model<T> (from @InjectModel)
// outside Nest's DI container fails to compile otherwise.
function approvalModel(): Model<ApprovalDocument> {
  return mongoose.model<ApprovalDocument>('Approval', ApprovalSchema);
}

describe.skipIf(!integrationTestsEnabled())('Approval persistence (integration, real database)', () => {
  const uri = integrationTestsEnabled() ? getTestMongoUri() : '';
  const createdTenants: string[] = [];

  afterAll(async () => {
    await Promise.all(createdTenants.map((tenantId) => cleanupTenant(uri, tenantId)));
    await disconnectFixtureConnection();
  });

  async function repo() {
    await mongoose.connect(uri).catch(() => undefined); // tenant-fixture.ts's own helpers already connect; this is a harmless no-op once connected.
    return new MongooseApprovalRepository(approvalModel());
  }

  function trackedTenant(): string {
    const tenantId = randomTenantId();
    createdTenants.push(tenantId);
    return tenantId;
  }

  function input(tenantId: string, overrides: Partial<NewApproval> = {}): NewApproval {
    return {
      tenantId,
      runId: 'run_1',
      conversationId: 'conv_1',
      orderId: 'ORD-1001',
      customerRef: 'cust_1',
      amountCents: 5000,
      citations: ['d1-0'],
      verifierVerdictAtProposal: [{ code: 'ORDER_OWNERSHIP_MISMATCH', passed: true }],
      now: new Date(),
      approvalExpiryDays: 7,
      ...overrides,
    };
  }

  it(
    'the partial unique index rejects a second ACTIVE approval for the same tenant+order, but allows a new one once the first is inactive',
    async () => {
      const tenantId = trackedTenant();
      const repository = await repo();

      const first = await repository.create(input(tenantId, { orderId: 'ORD-2001' }));

      await expect(repository.create(input(tenantId, { orderId: 'ORD-2001' }))).rejects.toMatchObject({ code: 11000 });

      // Deactivate the first (reject it) - the partial index's filter ({ active: true }) no
      // longer covers this row, so a second active row for the same order is allowed again.
      await repository.reject(tenantId, first.id, 'key_1', new Date());
      const second = await repository.create(input(tenantId, { orderId: 'ORD-2001' }));
      expect(second.id).not.toBe(first.id);
    },
    30_000,
  );

  it(
    'the partial unique index does NOT block a second active approval for a DIFFERENT order, or the same order under a different tenant',
    async () => {
      const tenantId = trackedTenant();
      const otherTenantId = trackedTenant();
      const repository = await repo();

      await repository.create(input(tenantId, { orderId: 'ORD-2002' }));
      const differentOrder = await repository.create(input(tenantId, { orderId: 'ORD-2003' }));
      const sameOrderDifferentTenant = await repository.create(input(otherTenantId, { orderId: 'ORD-2002' }));

      expect(differentOrder).toBeTruthy();
      expect(sameOrderDifferentTenant).toBeTruthy();
    },
    30_000,
  );

  it(
    'two REAL concurrent beginExecution calls on one approval resolve to exactly one winner (no sleeps - a genuine database-level race)',
    async () => {
      const tenantId = trackedTenant();
      const repository = await repo();
      const created = await repository.create(input(tenantId, { orderId: 'ORD-2004' }));

      const [a, b] = await Promise.all([
        repository.beginExecution(tenantId, created.id, [], new Date()),
        repository.beginExecution(tenantId, created.id, [], new Date()),
      ]);

      const winners = [a, b].filter((r) => r !== null);
      expect(winners).toHaveLength(1);

      const final = await repository.findById(tenantId, created.id);
      expect(final?.status).toBe('executing');
      expect(final?.attemptCount).toBe(1); // only the winner's write landed, never double-applied
    },
    30_000,
  );

  it(
    'takeOverStuckExecution only succeeds when executingSince exactly matches the current stored value - the compare-and-swap amendment B\'s lease relies on',
    async () => {
      const tenantId = trackedTenant();
      const repository = await repo();
      const created = await repository.create(input(tenantId, { orderId: 'ORD-2005' }));
      const begun = await repository.beginExecution(tenantId, created.id, [], new Date());
      const staleExecutingSince = begun!.executingSince!;

      // A caller holding an OUTDATED snapshot (not the current executingSince) can never steal -
      // this is the real mechanism that makes "only after the lease expires" safe: the service
      // layer (a later stage) only ever calls this with the executingSince it just read, and a
      // read that's already out of date (because someone else already renewed it) naturally fails.
      const mismatched = await repository.takeOverStuckExecution(tenantId, created.id, new Date(staleExecutingSince.getTime() - 1), new Date());
      expect(mismatched).toBeNull();

      const later = new Date(staleExecutingSince.getTime() + 120_000);
      const result = await repository.takeOverStuckExecution(tenantId, created.id, staleExecutingSince, later);
      expect(result?.executingSince).toEqual(later);
      expect(result?.attemptCount).toBe(2);
    },
    30_000,
  );

  it(
    'the createdAt TTL index on Approval matches the retention the test harness configured (45 days) - and is independent of CHAT_RETENTION_DAYS\'s own 30-day test value',
    async () => {
      const model = approvalModel();
      const indexes = (await model.listIndexes()) as unknown as Array<{ name: string; key: Record<string, number>; expireAfterSeconds?: number }>;
      const ttlIndex = indexes.find((idx) => idx.expireAfterSeconds !== undefined && Object.keys(idx.key).length === 1 && idx.key.createdAt === 1);

      expect(ttlIndex).toBeDefined();
      expect(ttlIndex?.expireAfterSeconds).toBe(45 * 24 * 60 * 60);
    },
    30_000,
  );

  it(
    'the active-per-order partial unique index itself is unique and partial, exactly as configured',
    async () => {
      const model = approvalModel();
      const indexes = (await model.listIndexes()) as unknown as Array<{
        name: string;
        unique?: boolean;
        partialFilterExpression?: Record<string, unknown>;
      }>;
      const activeOrderIndex = indexes.find((idx) => idx.name === 'approval_active_order_unique');

      expect(activeOrderIndex?.unique).toBe(true);
      expect(activeOrderIndex?.partialFilterExpression).toEqual({ active: true });
    },
    30_000,
  );

  it('tenant isolation: another tenant\'s id never matches findById or any transition method', async () => {
    const tenantId = trackedTenant();
    const otherTenantId = trackedTenant();
    const repository = await repo();
    const created = await repository.create(input(tenantId, { orderId: 'ORD-2006' }));

    expect(await repository.findById(otherTenantId, created.id)).toBeNull();
    expect(await repository.beginExecution(otherTenantId, created.id, [], new Date())).toBeNull();
    expect(await repository.reject(otherTenantId, created.id, 'key_1', new Date())).toBeNull();

    // Confirm the real tenant still can, proving the isolation above was about the tenant id,
    // not a broken id/lookup.
    expect(await repository.findById(tenantId, created.id)).not.toBeNull();
  });

  it(
    'a legacy-shaped document (inserted directly, missing every optional field) is readable and transitionable via the repository',
    async () => {
      const tenantId = trackedTenant();
      const ApprovalModel = approvalModel();

      const id = new Types.ObjectId();
      await ApprovalModel.create({
        _id: id,
        tenantId,
        runId: 'run_legacy',
        conversationId: 'conv_legacy',
        orderId: 'ORD-2007',
        customerRef: 'cust_1',
        amountCents: 1000,
        status: 'pending',
        active: true,
        idempotencyKey: `apr_${id.toHexString()}`,
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
        // Deliberately omitted: citations, verifierVerdictAtProposal, retryable,
        // attemptCount, executionStartedAt, executingSince, decidedBy, decidedAt,
        // reasonCode, executionResultCode, verifierVerdictAtDecision - every one of
        // these must fall back to its schema default, never throw on read.
      });

      const repository = await repo();
      const found = await repository.findById(tenantId, id.toString());
      expect(found?.citations).toEqual([]);
      expect(found?.verifierVerdictAtProposal).toEqual([]);
      expect(found?.attemptCount).toBe(0);
      expect(found?.retryable).toBeNull();

      const begun = await repository.beginExecution(tenantId, id.toString(), [], new Date());
      expect(begun?.status).toBe('executing');
    },
    30_000,
  );
});
