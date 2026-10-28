import { describe, expect, it, vi } from 'vitest';
import {
  definitionsMatch,
  EnsureIndexDeps,
  ensureCollectionExists,
  ensureIndexes,
  ensureRegularIndexes,
  ExistingSearchIndex,
  RegularIndexModel,
} from './db-ensure-indexes';
import { POLICY_CHUNK_VECTOR_INDEX_DEFINITION, POLICY_CHUNK_VECTOR_INDEX_NAME } from '../db/schemas/policy-chunk.schema';

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

function makeRegularModel(name: string, diff: { toDrop: string[]; toCreate: string[] }): RegularIndexModel {
  return {
    name,
    diffIndexes: vi.fn(async () => diff),
    syncIndexes: vi.fn(async () => diff.toDrop),
  };
}

describe('ensureRegularIndexes', () => {
  it('syncs every model and logs "already in sync" when nothing changed', async () => {
    const models = [makeRegularModel('Tenant', { toDrop: [], toCreate: [] }), makeRegularModel('ApiKey', { toDrop: [], toCreate: [] })];
    const logs: string[] = [];
    await ensureRegularIndexes(models, (m) => logs.push(m));

    for (const model of models) {
      expect(model.syncIndexes).not.toHaveBeenCalled(); // nothing to do, so syncIndexes is skipped entirely
    }
    expect(logs.filter((l) => l.includes('already in sync'))).toHaveLength(2);
  });

  it('explicitly logs every index name to be created and dropped, then syncs', async () => {
    const model = makeRegularModel('ApiKey', { toDrop: ['old_index_1'], toCreate: ['hash_1'] });
    const logs: string[] = [];
    await ensureRegularIndexes([model], (m) => logs.push(m));

    expect(logs.some((l) => l.includes('creating') && l.includes('hash_1'))).toBe(true);
    expect(logs.some((l) => l.includes('dropping') && l.includes('old_index_1'))).toBe(true);
    expect(model.syncIndexes).toHaveBeenCalledTimes(1);
  });

  it('--dry-run reports the plan but never calls syncIndexes', async () => {
    const model = makeRegularModel('ApiKey', { toDrop: ['old_index_1'], toCreate: ['hash_1'] });
    const logs: string[] = [];
    await ensureRegularIndexes([model], (m) => logs.push(m), { dryRun: true });

    expect(logs.some((l) => l.includes('[dry-run]') && l.includes('would create') && l.includes('hash_1'))).toBe(true);
    expect(logs.some((l) => l.includes('[dry-run]') && l.includes('would drop') && l.includes('old_index_1'))).toBe(true);
    expect(model.syncIndexes).not.toHaveBeenCalled();
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
