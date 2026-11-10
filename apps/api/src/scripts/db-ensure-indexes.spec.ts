import { describe, expect, it, vi } from 'vitest';
import {
  buildIndexPlans,
  checkProtectedIndexes,
  CollectionIndexDeps,
  definitionsMatch,
  EnsureIndexDeps,
  ensureCollectionExists,
  ensureCollectionIndexes,
  ensureIndexes,
  ExistingIndexInfo,
  ExistingSearchIndex,
  findSingleFieldTtlIndex,
  ProtectedIndexSpec,
  RegularIndexSpec,
  resolveRetentionDays,
} from './db-ensure-indexes';
import { POLICY_CHUNK_VECTOR_INDEX_DEFINITION, POLICY_CHUNK_VECTOR_INDEX_NAME } from '../db/schemas/policy-chunk.schema';
import { APPROVAL_ACTIVE_ORDER_UNIQUE_INDEX_NAME } from '../approvals/schemas/approval.schema';

function makeDeps(overrides: Partial<EnsureIndexDeps> = {}): EnsureIndexDeps {
  return {
    listCollectionNames: vi.fn(async () => []),
    createCollection: vi.fn(async () => undefined),
    listSearchIndexes: vi.fn(async () => []),
    createSearchIndex: vi.fn(async () => 'new-index-id'),
    ...overrides,
  };
}

describe('ensureCollectionExists', () => {
  it('creates the collection when it is missing', async () => {
    const deps = makeDeps({ listCollectionNames: vi.fn(async () => []) });
    await ensureCollectionExists(deps, () => undefined);
    expect(deps.createCollection).toHaveBeenCalledTimes(1);
  });

  it('does not create the collection when it already exists', async () => {
    const deps = makeDeps({ listCollectionNames: vi.fn(async () => ['policyChunks']) });
    await ensureCollectionExists(deps, () => undefined);
    expect(deps.createCollection).not.toHaveBeenCalled();
  });

  it('treats a race-condition "already exists" error from createCollection as success', async () => {
    const deps = makeDeps({
      listCollectionNames: vi.fn(async () => []), // missing at check time
      createCollection: vi.fn(async () => {
        throw new Error('Collection already exists. NamespaceExists'); // but another process created it first
      }),
    });
    await expect(ensureCollectionExists(deps, () => undefined)).resolves.toBeUndefined();
  });

  it('propagates a genuinely different error from createCollection', async () => {
    const deps = makeDeps({
      listCollectionNames: vi.fn(async () => []),
      createCollection: vi.fn(async () => {
        throw new Error('connection refused');
      }),
    });
    await expect(ensureCollectionExists(deps, () => undefined)).rejects.toThrow('connection refused');
  });

  it('--dry-run reports it would create the collection, without creating it', async () => {
    const deps = makeDeps({ listCollectionNames: vi.fn(async () => []) });
    const logs: string[] = [];
    await ensureCollectionExists(deps, (m) => logs.push(m), true);

    expect(deps.createCollection).not.toHaveBeenCalled();
    expect(logs.some((l) => l.includes('[dry-run]') && l.includes('would create'))).toBe(true);
  });
});

describe('definitionsMatch', () => {
  it('matches the real expected definition against itself', () => {
    expect(
      definitionsMatch(POLICY_CHUNK_VECTOR_INDEX_DEFINITION.definition, POLICY_CHUNK_VECTOR_INDEX_DEFINITION.definition),
    ).toBe(true);
  });

  it('rejects a definition missing a field', () => {
    const incomplete = { fields: POLICY_CHUNK_VECTOR_INDEX_DEFINITION.definition.fields.slice(0, 1) };
    expect(definitionsMatch(incomplete, POLICY_CHUNK_VECTOR_INDEX_DEFINITION.definition)).toBe(false);
  });
});

describe('findSingleFieldTtlIndex', () => {
  it('matches only a single-field index on the given field that carries expireAfterSeconds', () => {
    const indexes: ExistingIndexInfo[] = [
      { name: '_id_', key: { _id: 1 } },
      { name: 'tenantId_1_createdAt_1', key: { tenantId: 1, createdAt: 1 } }, // compound, no expireAfterSeconds
      { name: 'createdAt_1', key: { createdAt: 1 }, expireAfterSeconds: 2_592_000 },
    ];
    expect(findSingleFieldTtlIndex(indexes, 'createdAt')?.name).toBe('createdAt_1');
  });

  it('returns undefined when no TTL index exists on that field', () => {
    expect(findSingleFieldTtlIndex([{ name: '_id_', key: { _id: 1 } }], 'createdAt')).toBeUndefined();
  });
});

describe('ensureIndexes', () => {
  it('creates the collection and the index when neither exist', async () => {
    let listCallCount = 0;
    const deps = makeDeps({
      listCollectionNames: vi.fn(async () => []),
      listSearchIndexes: vi.fn(async () => {
        listCallCount += 1;
        // First call (the "does it exist" check): missing.
        if (listCallCount === 1) {
          return [];
        }
        // Subsequent calls (polling after creation): immediately queryable,
        // so the real setTimeout-based poll loop never actually waits.
        const result: ExistingSearchIndex[] = [
          {
            name: POLICY_CHUNK_VECTOR_INDEX_NAME,
            queryable: true,
            status: 'READY',
            latestDefinition: POLICY_CHUNK_VECTOR_INDEX_DEFINITION.definition,
          },
        ];
        return result;
      }),
    });

    const logs: string[] = [];
    await ensureIndexes(deps, (m) => logs.push(m));

    expect(deps.createCollection).toHaveBeenCalledTimes(1);
    expect(deps.createSearchIndex).toHaveBeenCalledTimes(1);
    expect(logs.some((l) => l.includes('is queryable'))).toBe(true);
  });

  it('does nothing when the index already exists, matches, and is queryable', async () => {
    const deps = makeDeps({
      listCollectionNames: vi.fn(async () => ['policyChunks']),
      listSearchIndexes: vi.fn(async () => [
        {
          name: POLICY_CHUNK_VECTOR_INDEX_NAME,
          queryable: true,
          latestDefinition: POLICY_CHUNK_VECTOR_INDEX_DEFINITION.definition,
        },
      ]),
    });

    await ensureIndexes(deps, () => undefined);

    expect(deps.createSearchIndex).not.toHaveBeenCalled();
  });

  it('throws without auto-fixing when an existing index definition does not match', async () => {
    const deps = makeDeps({
      listCollectionNames: vi.fn(async () => ['policyChunks']),
      listSearchIndexes: vi.fn(async () => [
        { name: POLICY_CHUNK_VECTOR_INDEX_NAME, queryable: true, latestDefinition: { fields: [] } },
      ]),
    });

    await expect(ensureIndexes(deps, () => undefined)).rejects.toThrow(/does not match/);
    expect(deps.createSearchIndex).not.toHaveBeenCalled();
  });

  it('--dry-run reports it would create the index, without creating it or the collection', async () => {
    const deps = makeDeps({
      listCollectionNames: vi.fn(async () => []),
      listSearchIndexes: vi.fn(async () => []),
    });
    const logs: string[] = [];
    await ensureIndexes(deps, (m) => logs.push(m), true);

    expect(deps.createCollection).not.toHaveBeenCalled();
    expect(deps.createSearchIndex).not.toHaveBeenCalled();
    expect(logs.some((l) => l.includes('[dry-run]') && l.includes(POLICY_CHUNK_VECTOR_INDEX_NAME) && l.includes('would create'))).toBe(
      true,
    );
  });

  it('a mismatched existing definition is still an error under --dry-run', async () => {
    const deps = makeDeps({
      listCollectionNames: vi.fn(async () => ['policyChunks']),
      listSearchIndexes: vi.fn(async () => [
        { name: POLICY_CHUNK_VECTOR_INDEX_NAME, queryable: true, latestDefinition: { fields: [] } },
      ]),
    });

    await expect(ensureIndexes(deps, () => undefined, true)).rejects.toThrow(/does not match/);
  });
});

describe('ensureCollectionIndexes', () => {
  interface FakeState {
    exists: boolean;
    /** Secondary indexes only - the fake never models the implicit _id_ index. */
    indexes: ExistingIndexInfo[];
  }

  function sameKeys(a: Record<string, number>, b: Record<string, number>): boolean {
    const aKeys = Object.keys(a);
    const bKeys = Object.keys(b);
    return aKeys.length === bKeys.length && aKeys.every((k) => a[k] === b[k]);
  }

  /**
   * A fake that mimics just enough of mongoose's own diffIndexes()
   * semantics (schema index not present in the collection -> toCreate;
   * collection index not declared on the schema -> toDrop) to reproduce the
   * real Stage 4 bug: a TTL index created out of band looks exactly like a
   * stray to this diff, the same way it does to the real mongoose method
   * (see the module's own doc comment on `ensureCollectionIndexes`). The
   * fix under test is that `ensureCollectionIndexes` must never let that
   * diff drop the TTL index.
   */
  function makeFakeDeps(
    label: string,
    collectionName: string,
    schemaIndexes: RegularIndexSpec[],
    state: FakeState,
    ttl?: { field: string; expireAfterSeconds: number },
  ): CollectionIndexDeps & { calls: { created: string[]; dropped: string[]; ttlCreated: number; ttlCollMod: number } } {
    const calls = { created: [] as string[], dropped: [] as string[], ttlCreated: 0, ttlCollMod: 0 };
    return {
      label,
      collectionName,
      listCollectionNames: async () => (state.exists ? [collectionName] : []),
      createCollection: async () => {
        state.exists = true;
      },
      listIndexes: async () => state.indexes,
      diffSchemaIndexes: async () => {
        const toDrop = state.indexes.filter((idx) => !schemaIndexes.some(([keys]) => sameKeys(keys, idx.key))).map((idx) => idx.name);
        const toCreate = schemaIndexes.filter(([keys]) => !state.indexes.some((idx) => sameKeys(idx.key, keys)));
        return { toDrop, toCreate };
      },
      dropIndexes: async (names) => {
        calls.dropped.push(...names);
        state.indexes = state.indexes.filter((idx) => !names.includes(idx.name));
      },
      createSchemaIndexes: async (toCreate) => {
        for (const [keys, options] of toCreate) {
          const name =
            typeof options.name === 'string'
              ? options.name
              : Object.entries(keys)
                  .map(([f, d]) => `${f}_${d}`)
                  .join('_');
          calls.created.push(name);
          state.indexes.push({ name, key: keys, unique: Boolean(options.unique) });
        }
      },
      ttl: ttl
        ? {
            field: ttl.field,
            expireAfterSeconds: ttl.expireAfterSeconds,
            createIndex: async () => {
              calls.ttlCreated += 1;
              state.indexes.push({ name: `${ttl.field}_1`, key: { [ttl.field]: 1 }, expireAfterSeconds: ttl.expireAfterSeconds });
            },
            updateExpiry: async () => {
              calls.ttlCollMod += 1;
              const idx = findSingleFieldTtlIndex(state.indexes, ttl.field);
              if (idx) idx.expireAfterSeconds = ttl.expireAfterSeconds;
            },
          }
        : undefined,
      calls,
    };
  }

  const messageSchemaIndexes: RegularIndexSpec[] = [[{ tenantId: 1, conversationId: 1, createdAt: 1 }, {}]];

  it('(d) a second run on an unchanged database is a true no-op - the Stage 4 bug reproduced and fixed', async () => {
    const state: FakeState = { exists: true, indexes: [] };
    const deps = makeFakeDeps('Message', 'messages', messageSchemaIndexes, state, {
      field: 'createdAt',
      expireAfterSeconds: 2_592_000,
    });

    // First run: creates the compound schema index and the TTL index.
    await ensureCollectionIndexes(deps, () => undefined);
    expect(deps.calls.created).toEqual(['tenantId_1_conversationId_1_createdAt_1']);
    expect(deps.calls.ttlCreated).toBe(1);
    expect(deps.calls.dropped).toEqual([]);

    // Second run against the now-populated state: the TTL index
    // ("createdAt_1") does not match the compound schema index, so a
    // blind diff (the old bug) would call it a stray and drop it. It must
    // not be dropped, and nothing else should happen either.
    const logs: string[] = [];
    await ensureCollectionIndexes(deps, (m) => logs.push(m));

    expect(deps.calls.dropped).toEqual([]); // still empty - the TTL index was never dropped
    expect(deps.calls.created).toHaveLength(1); // unchanged from the first run
    expect(deps.calls.ttlCreated).toBe(1); // unchanged - not recreated
    expect(deps.calls.ttlCollMod).toBe(0);
    expect(logs.some((l) => l.includes('Message: already in sync.'))).toBe(true);
  });

  it('(b) a changed expireAfterSeconds is applied with collMod only - the TTL index is never dropped or recreated', async () => {
    const state: FakeState = {
      exists: true,
      indexes: [
        { name: 'tenantId_1_conversationId_1_createdAt_1', key: { tenantId: 1, conversationId: 1, createdAt: 1 } },
        { name: 'createdAt_1', key: { createdAt: 1 }, expireAfterSeconds: 86_400 },
      ],
    };
    const deps = makeFakeDeps('Message', 'messages', messageSchemaIndexes, state, {
      field: 'createdAt',
      expireAfterSeconds: 2_592_000,
    });

    const logs: string[] = [];
    await ensureCollectionIndexes(deps, (m) => logs.push(m));

    expect(deps.calls.dropped).toEqual([]); // never dropped
    expect(deps.calls.ttlCreated).toBe(0); // never recreated
    expect(deps.calls.ttlCollMod).toBe(1); // only collMod
    expect(state.indexes.find((i) => i.name === 'createdAt_1')?.expireAfterSeconds).toBe(2_592_000);
    expect(logs.some((l) => l.includes('updating the TTL index') && l.includes('collMod'))).toBe(true);
  });

  it('(d) an unexpected stray index is still reported and dropped, but only in real mode', async () => {
    const state: FakeState = {
      exists: true,
      indexes: [
        { name: 'tenantId_1_conversationId_1_createdAt_1', key: { tenantId: 1, conversationId: 1, createdAt: 1 } },
        { name: 'createdAt_1', key: { createdAt: 1 }, expireAfterSeconds: 2_592_000 },
        { name: 'old_stray_1', key: { oldField: 1 } },
      ],
    };
    const deps = makeFakeDeps('Message', 'messages', messageSchemaIndexes, state, {
      field: 'createdAt',
      expireAfterSeconds: 2_592_000,
    });

    const dryRunLogs: string[] = [];
    await ensureCollectionIndexes(deps, (m) => dryRunLogs.push(m), true);
    expect(deps.calls.dropped).toEqual([]);
    expect(dryRunLogs.some((l) => l.includes('[dry-run] would drop') && l.includes('old_stray_1'))).toBe(true);
    expect(state.indexes.some((i) => i.name === 'old_stray_1')).toBe(true); // unchanged

    const realLogs: string[] = [];
    await ensureCollectionIndexes(deps, (m) => realLogs.push(m));
    expect(deps.calls.dropped).toEqual(['old_stray_1']); // dropped, and TTL/schema indexes left alone
    expect(realLogs.some((l) => l.includes('dropping') && l.includes('old_stray_1'))).toBe(true);
    expect(state.indexes.some((i) => i.name === 'old_stray_1')).toBe(false);
    expect(state.indexes.some((i) => i.name === 'createdAt_1')).toBe(true);
  });

  it('(c) a collection that does not exist yet is reported as such, not "already in sync"', async () => {
    // Mirrors Tenant: no secondary schema indexes declared at all, so a
    // blind toCreate/toDrop-only check would be empty even though the
    // collection itself is missing - this is the exact confusion the old
    // script had for Tenant.
    const state: FakeState = { exists: false, indexes: [] };
    const deps = makeFakeDeps('Tenant', 'tenants', [], state);

    const logs: string[] = [];
    await ensureCollectionIndexes(deps, (m) => logs.push(m), true);

    expect(logs.some((l) => l.includes('Tenant: collection "tenants" does not exist yet.'))).toBe(true);
    expect(logs.some((l) => l.includes('[dry-run] would create the collection'))).toBe(true);
    expect(logs.some((l) => l.includes('already in sync'))).toBe(false);
  });

  it('(c) reports existing index names and creates the collection in real mode when missing', async () => {
    const state: FakeState = { exists: false, indexes: [] };
    const deps = makeFakeDeps('Tenant', 'tenants', [], state);

    const logs: string[] = [];
    await ensureCollectionIndexes(deps, (m) => logs.push(m));

    expect(state.exists).toBe(true); // createCollection() was actually called
    expect(logs.some((l) => l.includes('does not exist yet - creating it'))).toBe(true);
  });

  it('reports "already in sync" (and makes zero calls) for a collection with no TTL and nothing to change', async () => {
    const state: FakeState = { exists: true, indexes: [{ name: 'hash_1', key: { hash: 1 }, unique: true }] };
    const deps = makeFakeDeps('ApiKey', 'apiKeys', [[{ hash: 1 }, { unique: true }]], state);

    const logs: string[] = [];
    await ensureCollectionIndexes(deps, (m) => logs.push(m));

    expect(deps.calls.created).toEqual([]);
    expect(deps.calls.dropped).toEqual([]);
    expect(logs.some((l) => l.includes('ApiKey: already in sync.'))).toBe(true);
  });

  it('--dry-run never mutates state, even with a create, a drop, and a TTL collMod all pending at once', async () => {
    const state: FakeState = {
      exists: true,
      indexes: [
        { name: 'createdAt_1', key: { createdAt: 1 }, expireAfterSeconds: 86_400 },
        { name: 'old_stray_1', key: { oldField: 1 } },
      ],
    };
    const before = JSON.parse(JSON.stringify(state));
    const deps = makeFakeDeps('Message', 'messages', messageSchemaIndexes, state, {
      field: 'createdAt',
      expireAfterSeconds: 2_592_000,
    });

    const logs: string[] = [];
    await ensureCollectionIndexes(deps, (m) => logs.push(m), true);

    expect(state).toEqual(before);
    expect(deps.calls).toEqual({ created: [], dropped: [], ttlCreated: 0, ttlCollMod: 0 });
    expect(logs.some((l) => l.includes('[dry-run] would create') && l.includes('tenantId_1_conversationId_1_createdAt_1'))).toBe(
      true,
    );
    expect(logs.some((l) => l.includes('[dry-run] would drop') && l.includes('old_stray_1'))).toBe(true);
    expect(logs.some((l) => l.includes('[dry-run] would update the TTL index') && l.includes('collMod'))).toBe(true);
  });

  it('(index audit c) the "existing indexes" line annotates unique and TTL flags, not just bare names', async () => {
    const state: FakeState = {
      exists: true,
      indexes: [
        { name: 'tenantId_1_kid_1', key: { tenantId: 1, kid: 1 }, unique: true },
        { name: 'createdAt_1', key: { createdAt: 1 }, expireAfterSeconds: 2_592_000 },
        { name: 'tenantId_1_status_1', key: { tenantId: 1, status: 1 } },
      ],
    };
    const deps = makeFakeDeps(
      'CustomerPublicKey',
      'customerPublicKeys',
      [
        [{ tenantId: 1, kid: 1 }, { unique: true }],
        [{ tenantId: 1, status: 1 }, {}],
      ],
      state,
    );

    const logs: string[] = [];
    await ensureCollectionIndexes(deps, (m) => logs.push(m));

    expect(logs.some((l) => l.includes('existing indexes:') && l.includes('tenantId_1_kid_1 (unique)'))).toBe(true);
    expect(logs.some((l) => l.includes('existing indexes:') && l.includes('createdAt_1 (TTL 2592000s)'))).toBe(true);
    // A plain compound index with neither flag gets no parenthetical at all.
    const existingLine = logs.find((l) => l.includes('existing indexes:'))!;
    expect(existingLine).toContain('tenantId_1_status_1.'); // bare name, no "(...)" suffix - it's the last item before the trailing period
  });

  it('(Milestone 4) the "would create" line also shows unique and partialFilterExpression, not just the "existing indexes" line', async () => {
    const state: FakeState = { exists: false, indexes: [] };
    const toCreate: RegularIndexSpec[] = [
      [{ tenantId: 1, orderId: 1 }, { unique: true, partialFilterExpression: { active: true }, name: APPROVAL_ACTIVE_ORDER_UNIQUE_INDEX_NAME }],
    ];
    const deps = makeFakeDeps('Approval', 'approvals', toCreate, state);

    const logs: string[] = [];
    await ensureCollectionIndexes(deps, (m) => logs.push(m), true);

    expect(
      logs.some(
        (l) => l.includes(APPROVAL_ACTIVE_ORDER_UNIQUE_INDEX_NAME) && l.includes('unique') && l.includes('partial: {"active":true}'),
      ),
    ).toBe(true);
  });

  it('(index audit e) demonstrates, via dry-run only, what removing a redundant standalone tenantId_1 would drop - the real schema is NOT changed by this test', async () => {
    // Models today's REAL deployed state for a collection like Conversation:
    // a standalone tenantId_1 (from the schema's field-level `index: true`)
    // plus a compound index that already starts with tenantId. If the
    // field-level `index: true` were removed from the schema (a change this
    // test does NOT make to any real schema file), tenantId_1 would no
    // longer be schema-declared, and a dry run against this same existing
    // state would report it as a stray to drop - which is exactly what
    // this test demonstrates and nothing more.
    const state: FakeState = {
      exists: true,
      indexes: [
        { name: 'tenantId_1', key: { tenantId: 1 } },
        { name: 'tenantId_1_customerRef_1', key: { tenantId: 1, customerRef: 1 } },
      ],
    };
    // schemaIndexes deliberately omits a standalone { tenantId: 1 } entry -
    // this is the proposed schema change, expressed only as fake input here.
    const proposedSchemaIndexes: RegularIndexSpec[] = [[{ tenantId: 1, customerRef: 1 }, {}]];
    const deps = makeFakeDeps('Conversation', 'conversations', proposedSchemaIndexes, state);

    const logs: string[] = [];
    await ensureCollectionIndexes(deps, (m) => logs.push(m), true);

    expect(logs.some((l) => l.includes('[dry-run] would drop') && l.includes('tenantId_1'))).toBe(true);
    expect(deps.calls.dropped).toEqual([]); // dry-run - nothing was actually dropped
    expect(state.indexes.some((i) => i.name === 'tenantId_1')).toBe(true); // still present - this test changed nothing real
  });
});

describe('buildIndexPlans', () => {
  it('(index audit d) includes PolicyChunk in the regular-index collection plans, alongside its separate vector-search handling', () => {
    const { collectionPlans } = buildIndexPlans(2_592_000);
    const labels = collectionPlans.map((plan) => plan.label);

    expect(labels).toContain('PolicyChunk');
    expect(labels).toEqual([
      'Tenant',
      'ApiKey',
      'PolicyChunk',
      'PolicyDocument',
      'Conversation',
      'Message',
      'AgentRun',
      'CustomerPublicKey',
      'Approval',
    ]);

    const policyChunkPlan = collectionPlans.find((plan) => plan.label === 'PolicyChunk')!;
    expect(policyChunkPlan.collectionName).toBe('policyChunks');
    expect(policyChunkPlan.ttl).toBeUndefined(); // PolicyChunk has no retention TTL - only its regular field-level indexes are managed here
  });

  it('(Milestone 4) Approval has its own TTL field and the protected active-per-order partial unique index', () => {
    const { collectionPlans } = buildIndexPlans(2_592_000, 7_776_000);
    const approvalPlan = collectionPlans.find((plan) => plan.label === 'Approval')!;

    expect(approvalPlan.collectionName).toBe('approvals');
    expect(approvalPlan.ttl?.field).toBe('createdAt');
    expect(approvalPlan.ttl?.expireAfterSeconds).toBe(7_776_000); // the SEPARATE approval retention value, not the chat one
    expect(approvalPlan.protectedIndexes).toEqual([
      { name: APPROVAL_ACTIVE_ORDER_UNIQUE_INDEX_NAME, expectedUnique: true, expectedPartialFilterExpression: { active: true } },
    ]);
  });

  it('(Milestone 4 amendment F3) Approval\'s TTL is partial on active:false, and migrate is wired', () => {
    const { collectionPlans } = buildIndexPlans(2_592_000, 7_776_000);
    const approvalPlan = collectionPlans.find((plan) => plan.label === 'Approval')!;

    expect(approvalPlan.ttl?.partialFilterExpression).toEqual({ active: false });
    expect(approvalPlan.ttl?.migrate).toBeDefined();
  });

  it('no OTHER collection has a partial TTL or a migrate config - this is Approval-specific', () => {
    const { collectionPlans } = buildIndexPlans(2_592_000);
    for (const plan of collectionPlans) {
      if (plan.label === 'Approval' || !plan.ttl) continue;
      expect(plan.ttl.partialFilterExpression).toBeUndefined();
      expect(plan.ttl.migrate).toBeUndefined();
    }
  });

  it('(Milestone 4) defaults the approval retention to the same value as chat retention when not given separately', () => {
    const { collectionPlans } = buildIndexPlans(2_592_000);
    const approvalPlan = collectionPlans.find((plan) => plan.label === 'Approval')!;
    expect(approvalPlan.ttl?.expireAfterSeconds).toBe(2_592_000);
  });
});

describe('resolveRetentionDays', () => {
  it('returns the default when the env var is unset', () => {
    expect(resolveRetentionDays(undefined, 90, 'APPROVAL_RETENTION_DAYS')).toBe(90);
  });

  it('parses a valid override', () => {
    expect(resolveRetentionDays('120', 90, 'APPROVAL_RETENTION_DAYS')).toBe(120);
  });

  it('rejects a non-integer value', () => {
    expect(() => resolveRetentionDays('30.5', 90, 'APPROVAL_RETENTION_DAYS')).toThrow(/must be a positive integer/);
  });

  it('rejects zero and negative values', () => {
    expect(() => resolveRetentionDays('0', 90, 'APPROVAL_RETENTION_DAYS')).toThrow(/must be a positive integer/);
    expect(() => resolveRetentionDays('-5', 90, 'APPROVAL_RETENTION_DAYS')).toThrow(/must be a positive integer/);
  });

  it('rejects a non-numeric value', () => {
    expect(() => resolveRetentionDays('not-a-number', 90, 'APPROVAL_RETENTION_DAYS')).toThrow(/must be a positive integer/);
  });
});

describe('checkProtectedIndexes (Milestone 4 amendment C)', () => {
  const spec: ProtectedIndexSpec = {
    name: APPROVAL_ACTIVE_ORDER_UNIQUE_INDEX_NAME,
    expectedUnique: true,
    expectedPartialFilterExpression: { active: true },
  };

  it('does nothing when the index does not exist yet - diffSchemaIndexes\' own toCreate handles that normally', () => {
    expect(() => checkProtectedIndexes([], [spec])).not.toThrow();
  });

  it('does nothing when the existing index matches exactly', () => {
    const existing: ExistingIndexInfo[] = [
      { name: spec.name, key: { tenantId: 1, orderId: 1 }, unique: true, partialFilterExpression: { active: true } },
    ];
    expect(() => checkProtectedIndexes(existing, [spec])).not.toThrow();
  });

  it('throws when the unique flag does not match', () => {
    const existing: ExistingIndexInfo[] = [
      { name: spec.name, key: { tenantId: 1, orderId: 1 }, unique: false, partialFilterExpression: { active: true } },
    ];
    expect(() => checkProtectedIndexes(existing, [spec])).toThrow(/does not match/);
  });

  it('throws when the partialFilterExpression does not match', () => {
    const existing: ExistingIndexInfo[] = [
      { name: spec.name, key: { tenantId: 1, orderId: 1 }, unique: true, partialFilterExpression: { active: false } },
    ];
    expect(() => checkProtectedIndexes(existing, [spec])).toThrow(/does not match/);
  });

  it('throws when the existing index has no partialFilterExpression at all (e.g. it was created as a plain unique index by mistake)', () => {
    const existing: ExistingIndexInfo[] = [{ name: spec.name, key: { tenantId: 1, orderId: 1 }, unique: true }];
    expect(() => checkProtectedIndexes(existing, [spec])).toThrow(/does not match/);
  });

  it('is checked unconditionally by ensureCollectionIndexes, even under --dry-run, and never auto-drops the mismatched index', async () => {
    const state = {
      exists: true,
      indexes: [
        { name: spec.name, key: { tenantId: 1, orderId: 1 }, unique: false, partialFilterExpression: { active: true } },
      ] as ExistingIndexInfo[],
    };
    const deps: CollectionIndexDeps = {
      label: 'Approval',
      collectionName: 'approvals',
      listCollectionNames: async () => (state.exists ? ['approvals'] : []),
      createCollection: async () => undefined,
      listIndexes: async () => state.indexes,
      diffSchemaIndexes: async () => ({ toDrop: [spec.name], toCreate: [] }),
      dropIndexes: async () => undefined,
      createSchemaIndexes: async () => undefined,
      protectedIndexes: [spec],
    };

    await expect(ensureCollectionIndexes(deps, () => undefined, true)).rejects.toThrow(/does not match/);
    await expect(ensureCollectionIndexes(deps, () => undefined, false)).rejects.toThrow(/does not match/);
  });

  it('never appears in toDrop even when diffSchemaIndexes wants to drop it, once it matches - the same protection the TTL index already gets', async () => {
    const state = {
      exists: true,
      indexes: [
        { name: spec.name, key: { tenantId: 1, orderId: 1 }, unique: true, partialFilterExpression: { active: true } },
      ] as ExistingIndexInfo[],
    };
    const dropped: string[] = [];
    const deps: CollectionIndexDeps = {
      label: 'Approval',
      collectionName: 'approvals',
      listCollectionNames: async () => ['approvals'],
      createCollection: async () => undefined,
      listIndexes: async () => state.indexes,
      // Deliberately wrong, simulating a confused diff - this must be filtered out before
      // ever reaching dropIndexes(), exactly like the ttlExisting?.name filter above it.
      diffSchemaIndexes: async () => ({ toDrop: [spec.name], toCreate: [] }),
      dropIndexes: async (names) => {
        dropped.push(...names);
      },
      createSchemaIndexes: async () => undefined,
      protectedIndexes: [spec],
    };

    await ensureCollectionIndexes(deps, () => undefined);
    expect(dropped).toEqual([]);
  });
});

describe('TTL partial-filter migration (amendment F3)', () => {
  function makeDepsWithTtl(opts: {
    existingTtl?: ExistingIndexInfo;
    desiredPartialFilterExpression?: Record<string, unknown>;
    blockingCount?: number;
  }): CollectionIndexDeps & { dropped: string[]; created: number; migrated: number } {
    const result: CollectionIndexDeps & { dropped: string[]; created: number; migrated: number } = {
      label: 'Approval',
      collectionName: 'approvals',
      dropped: [],
      created: 0,
      migrated: 0,
      listCollectionNames: async () => ['approvals'],
      createCollection: async () => undefined,
      listIndexes: async () => (opts.existingTtl ? [opts.existingTtl] : []),
      diffSchemaIndexes: async () => ({ toDrop: [], toCreate: [] }),
      dropIndexes: async () => undefined,
      createSchemaIndexes: async () => undefined,
      ttl: {
        field: 'createdAt',
        expireAfterSeconds: 7_776_000,
        partialFilterExpression: opts.desiredPartialFilterExpression,
        createIndex: async () => {
          result.created += 1;
        },
        updateExpiry: async () => undefined,
        migrate: {
          countBlocking: async () => opts.blockingCount ?? 0,
          dropAndRecreate: async (name: string) => {
            result.dropped.push(name);
            result.migrated += 1;
          },
        },
      },
    };
    return result;
  }

  it('STOPS with a clear error when the existing TTL has no partialFilterExpression but one is now desired - dry-run or not, without the flag', async () => {
    const deps = makeDepsWithTtl({
      existingTtl: { name: 'createdAt_1', key: { createdAt: 1 }, expireAfterSeconds: 7_776_000 },
      desiredPartialFilterExpression: { active: false },
    });

    await expect(ensureCollectionIndexes(deps, () => undefined, true, false)).rejects.toThrow(/cannot change a TTL index's partialFilterExpression/);
    await expect(ensureCollectionIndexes(deps, () => undefined, false, false)).rejects.toThrow(/cannot change a TTL index's partialFilterExpression/);
    expect(deps.dropped).toEqual([]);
    expect(deps.migrated).toBe(0);
  });

  it('the error message names the exact migration command', async () => {
    const deps = makeDepsWithTtl({
      existingTtl: { name: 'createdAt_1', key: { createdAt: 1 }, expireAfterSeconds: 7_776_000 },
      desiredPartialFilterExpression: { active: false },
    });
    await expect(ensureCollectionIndexes(deps, () => undefined, true, false)).rejects.toThrow(/--migrate-approval-ttl/);
  });

  it('--dry-run alone never performs the migration, even with the flag - it only reports what it would do', async () => {
    const deps = makeDepsWithTtl({
      existingTtl: { name: 'createdAt_1', key: { createdAt: 1 }, expireAfterSeconds: 7_776_000 },
      desiredPartialFilterExpression: { active: false },
      blockingCount: 0,
    });
    const logs: string[] = [];
    await ensureCollectionIndexes(deps, (m) => logs.push(m), true, true);

    expect(deps.dropped).toEqual([]);
    expect(deps.migrated).toBe(0);
    expect(logs.some((l) => l.includes('[dry-run]') && l.includes('would check for any blocking document'))).toBe(true);
  });

  it('with the flag and zero blocking documents, migrates for real: drops the old index, creates the new partial one', async () => {
    const deps = makeDepsWithTtl({
      existingTtl: { name: 'createdAt_1', key: { createdAt: 1 }, expireAfterSeconds: 7_776_000 },
      desiredPartialFilterExpression: { active: false },
      blockingCount: 0,
    });
    const logs: string[] = [];
    await ensureCollectionIndexes(deps, (m) => logs.push(m), false, true);

    expect(deps.dropped).toEqual(['createdAt_1']);
    expect(deps.migrated).toBe(1);
    expect(logs.some((l) => l.includes('migrating TTL index'))).toBe(true);
  });

  it('refuses to migrate when any document still has active:true, even with the flag', async () => {
    const deps = makeDepsWithTtl({
      existingTtl: { name: 'createdAt_1', key: { createdAt: 1 }, expireAfterSeconds: 7_776_000 },
      desiredPartialFilterExpression: { active: false },
      blockingCount: 3,
    });

    await expect(ensureCollectionIndexes(deps, () => undefined, false, true)).rejects.toThrow(/3 document\(s\) still have active:true/);
    expect(deps.dropped).toEqual([]);
    expect(deps.migrated).toBe(0);
  });

  it('a brand-new collection with no existing TTL index at all just creates the partial one directly - no migration needed', async () => {
    const deps = makeDepsWithTtl({
      existingTtl: undefined,
      desiredPartialFilterExpression: { active: false },
    });
    await ensureCollectionIndexes(deps, () => undefined, false, false);
    expect(deps.created).toBe(1);
    expect(deps.dropped).toEqual([]);
  });

  it('expireAfterSeconds-only changes (filter already matches) still use collMod, never the migration path', async () => {
    const deps = makeDepsWithTtl({
      existingTtl: { name: 'createdAt_1', key: { createdAt: 1 }, expireAfterSeconds: 2_592_000, partialFilterExpression: { active: false } },
      desiredPartialFilterExpression: { active: false },
    });
    const logs: string[] = [];
    await ensureCollectionIndexes(deps, (m) => logs.push(m), false, false);

    expect(deps.dropped).toEqual([]);
    expect(logs.some((l) => l.includes('collMod'))).toBe(true);
  });
});
