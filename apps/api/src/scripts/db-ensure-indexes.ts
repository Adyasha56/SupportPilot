/**
 * Manually run only - never from the app's own boot path (see
 * database.module.ts). Run once per database (dev, and separately the one
 * fixed test database, which needs --allow-test-db):
 *
 *   pnpm run db:ensure-indexes
 *   pnpm run db:ensure-indexes -- --allow-test-db   (for the shared test db)
 *   pnpm run db:ensure-indexes -- --dry-run         (prints the plan, changes nothing)
 *
 * --dry-run still connects and reads real state (so the plan it prints is
 * accurate), and the test_ database guard still applies to it - a dry-run
 * is not an exemption from that guard, only from making changes.
 *
 * Runs compiled JS (dist/scripts/...), not the .ts source directly: Node's
 * native TypeScript type stripping (stable since Node 24.12, confirmed
 * against the official docs) does not support decorators at all (a parser
 * error, no flag helps) and requires --experimental-transform-types even
 * just for constructor parameter properties - both used throughout our
 * NestJS code. This script itself doesn't use either today, but compiling
 * it the same way as every other script keeps one consistent, future-proof
 * execution mechanism rather than two different ones per script.
 *
 * createSearchIndex is NOT idempotent (confirmed against current MongoDB
 * docs), and attempting to create a duplicate-named index has been reported
 * to make Atlas Local deployments stop processing index management
 * requests entirely - so this always checks what already exists first and
 * never blindly (re)creates.
 */
import mongoose from 'mongoose';
import { assertNotTestDatabase, getDatabaseNameFromUri } from '../db/database-name';
import {
  POLICY_CHUNK_VECTOR_INDEX_DEFINITION,
  POLICY_CHUNK_VECTOR_INDEX_NAME,
  PolicyChunkSchema,
} from '../db/schemas/policy-chunk.schema';
import { ApiKeySchema } from '../db/schemas/api-key.schema';
import { TenantSchema } from '../db/schemas/tenant.schema';
import { PolicyDocumentSchema } from '../db/schemas/policy-document.schema';
import { ConversationSchema } from '../db/schemas/conversation.schema';
import { MessageSchema } from '../db/schemas/message.schema';
import { AgentRunSchema } from '../db/schemas/agent-run.schema';
import { CustomerPublicKeySchema } from '../db/schemas/customer-public-key.schema';

export const COLLECTION_NAME = 'policyChunks';
export const POLL_INTERVAL_MS = 10_000;
export const QUERYABLE_TIMEOUT_MS = 120_000;

export interface ExistingSearchIndex {
  name?: string;
  queryable?: boolean;
  status?: string;
  latestDefinition?: {
    fields?: Array<Record<string, unknown>>;
  };
}

/**
 * The minimal surface this script needs - deliberately NOT Mongoose's
 * Model<T> generic, which has enough internal generic machinery (virtuals,
 * statics, etc.) that assigning a concrete model to any re-typed parameter
 * fails to compile. Also lets tests inject a fake with none of that
 * machinery at all.
 */
export interface EnsureIndexDeps {
  listCollectionNames(): Promise<string[]>;
  createCollection(): Promise<void>;
  listSearchIndexes(): Promise<ExistingSearchIndex[]>;
  createSearchIndex(description: Record<string, unknown>): Promise<string>;
}

export function definitionsMatch(
  existing: ExistingSearchIndex['latestDefinition'],
  expected: typeof POLICY_CHUNK_VECTOR_INDEX_DEFINITION.definition,
): boolean {
  const existingFields = existing?.fields ?? [];
  if (existingFields.length !== expected.fields.length) {
    return false;
  }
  return expected.fields.every((expectedField) =>
    existingFields.some((existingField) => fieldsMatch(existingField, expectedField)),
  );
}

function fieldsMatch(
  existingField: Record<string, unknown>,
  expectedField: (typeof POLICY_CHUNK_VECTOR_INDEX_DEFINITION.definition.fields)[number],
): boolean {
  if (existingField.path !== expectedField.path || existingField.type !== expectedField.type) {
    return false;
  }
  if (expectedField.type === 'vector') {
    return (
      existingField.numDimensions === expectedField.numDimensions &&
      existingField.similarity === expectedField.similarity
    );
  }
  return true;
}

/**
 * Checks listCollections first (cheap, no side effect) rather than
 * unconditionally calling createCollection every run. If the collection is
 * missing, creates it - and if createCollection itself still throws an
 * "already exists" / NamespaceExists error (a concurrent creator raced us
 * between the check and the create), that specific error is treated as
 * success rather than a failure. Mongoose's own createCollection() has an
 * open issue about NOT always catching this itself
 * (Automattic/mongoose#9447), so this doesn't rely on that.
 */
export async function ensureCollectionExists(
  deps: EnsureIndexDeps,
  log: (message: string) => void,
  dryRun = false,
): Promise<void> {
  const names = await deps.listCollectionNames();
  if (names.includes(COLLECTION_NAME)) {
    log(`Collection "${COLLECTION_NAME}" already exists.`);
    return;
  }

  if (dryRun) {
    log(`[dry-run] Collection "${COLLECTION_NAME}" does not exist yet - would create it.`);
    return;
  }

  log(`Collection "${COLLECTION_NAME}" does not exist yet - creating it.`);
  try {
    await deps.createCollection();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/already exists|NamespaceExists/i.test(message)) {
      log(`Collection "${COLLECTION_NAME}" was created by a concurrent process - treating as success.`);
      return;
    }
    throw err;
  }
}

async function waitUntilQueryable(
  deps: EnsureIndexDeps,
  name: string,
  timeoutMs: number,
  log: (message: string) => void,
): Promise<void> {
  const startedAt = Date.now();
  const deadline = startedAt + timeoutMs;

  while (Date.now() < deadline) {
    const indexes = await deps.listSearchIndexes();
    const match = indexes.find((index) => index.name === name);
    if (match?.queryable) {
      log(`Index "${name}" is queryable after ${Math.round((Date.now() - startedAt) / 1000)}s.`);
      return;
    }
    const elapsedS = Math.round((Date.now() - startedAt) / 1000);
    log(`[${elapsedS}s elapsed] Waiting for index "${name}" - status: ${match?.status ?? 'unknown'}`);
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }

  throw new Error(
    `Timed out after ${Math.round(timeoutMs / 1000)}s waiting for index "${name}" to become queryable. ` +
      'This is safe to re-run: the index already exists on Atlas and this script will simply resume polling.',
  );
}

export async function ensureIndexes(deps: EnsureIndexDeps, log: (message: string) => void, dryRun = false): Promise<void> {
  await ensureCollectionExists(deps, log, dryRun);

  const existingIndexes = await deps.listSearchIndexes();
  const existing = existingIndexes.find((index) => index.name === POLICY_CHUNK_VECTOR_INDEX_NAME);

  if (existing) {
    // A definition mismatch is always reported as an error, dry-run or not -
    // it's a validation finding, not a mutation, so there's nothing for
    // --dry-run to defer.
    if (!definitionsMatch(existing.latestDefinition, POLICY_CHUNK_VECTOR_INDEX_DEFINITION.definition)) {
      throw new Error(
        `Index "${POLICY_CHUNK_VECTOR_INDEX_NAME}" already exists but its definition does not match ` +
          'the expected one. Not auto-fixing - resolve this manually (drop and recreate, or update the code).',
      );
    }
    if (existing.queryable) {
      log(`Index "${POLICY_CHUNK_VECTOR_INDEX_NAME}" already exists, matches, and is queryable. Nothing to do.`);
      return;
    }
    log(`Index "${POLICY_CHUNK_VECTOR_INDEX_NAME}" exists and matches, but isn't queryable yet.`);
    if (dryRun) {
      log(`[dry-run] Would wait for it to become queryable - no action needed, it already exists.`);
      return;
    }
    await waitUntilQueryable(deps, POLICY_CHUNK_VECTOR_INDEX_NAME, QUERYABLE_TIMEOUT_MS, log);
    return;
  }

  if (dryRun) {
    log(`[dry-run] Index "${POLICY_CHUNK_VECTOR_INDEX_NAME}" does not exist - would create it.`);
    return;
  }

  log(`Creating index "${POLICY_CHUNK_VECTOR_INDEX_NAME}"...`);
  await deps.createSearchIndex(POLICY_CHUNK_VECTOR_INDEX_DEFINITION);
  await waitUntilQueryable(deps, POLICY_CHUNK_VECTOR_INDEX_NAME, QUERYABLE_TIMEOUT_MS, log);
}

/**
 * One desired index set per collection, computed and diffed in one place -
 * this replaces the earlier two-system design (a generic `syncIndexes()`
 * pass over every schema, then a separate `ensureTtlIndexes()` pass) that
 * was NOT idempotent.
 *
 * Root cause (reproduced from mongoose@9.11.4's own source,
 * node_modules/mongoose/lib/model.js): `Model.syncIndexes()` calls
 * `diffIndexes()`, which treats ANY index present in the collection but not
 * declared on the schema (other than `_id`) as a "stray" to drop
 * (`getIndexesToDrop`, model.js:1525-1557) - it has no concept of an index
 * created out of band. The old `ensureTtlIndexes()` created the TTL index
 * via a raw driver `createIndex()` call, never via `schema.index(...)`, so
 * on every run AFTER the first, `ensureRegularIndexes()`'s blind
 * `model.syncIndexes()` call saw that TTL index as a stray and dropped it
 * ("Conversation: dropping index(es): updatedAt_1" etc.) - then
 * `ensureTtlIndexes()` ran afterward in the same script execution, found it
 * missing, and recreated it ("creating a TTL index"). Two independent
 * systems, each unaware of the other's desired state, fighting every run.
 *
 * The fix: still use mongoose's own (well-tested) `diffIndexes()` to decide
 * what the SCHEMA's own indexes need, but the TTL field's index name is
 * looked up from the SAME existing-indexes snapshot and explicitly excluded
 * from whatever `diffIndexes()` wants to drop, before anything is dropped.
 * The TTL index itself is then handled by its own create/collMod logic,
 * never a blind drop+recreate - see `planTtlAction` below.
 *
 * TTL config: Stage 4 amendment E - retention via TTL indexes on Message,
 * AgentRun, and Conversation, with a CONFIGURABLE retention period
 * (CHAT_RETENTION_DAYS, default 30). `expireAfterSeconds` needs to be a
 * runtime value read from env, not a number compiled into the schema, and
 * MongoDB lets an EXISTING TTL index's expiry be changed in place via
 * `collMod` (no drop+recreate needed) specifically so changing the setting
 * doesn't require a disruptive reindex - this script must never turn that
 * into a drop+recreate itself.
 *
 * Message and AgentRun only ever have `createdAt` (no `updatedAt` -
 * confirmed in their own schemas) - TTL there is the only sensible choice.
 * Conversation has both; TTL is deliberately on `updatedAt`, not
 * `createdAt` - a conversation that's still being actively used keeps
 * bumping `updatedAt` (every incrementMessageCount call), so an active
 * conversation's retention clock keeps resetting and only a genuinely
 * abandoned one expires 30 days after its LAST activity, not its first.
 *
 * TTL indexes are ordinary MongoDB indexes (created via the same
 * createIndex/collMod the driver uses for any index), not an Atlas
 * Search/Vector Search index - they do NOT count against the M0 cluster's
 * 3-Search-index cap, the same distinction policy-document.schema.ts's own
 * comment already draws for its own plain (non-Search) indexes.
 */
export interface ExistingIndexInfo {
  name: string;
  key: Record<string, number>;
  unique?: boolean;
  expireAfterSeconds?: number;
}

export type RegularIndexSpec = [Record<string, number>, Record<string, unknown>];

export interface RegularIndexDiffResult {
  /** Index names that the schema no longer wants. */
  toDrop: string[];
  /** [keys, options] pairs the schema wants but the collection doesn't have yet. */
  toCreate: RegularIndexSpec[];
}

export interface CollectionIndexDeps {
  /** For logging only. */
  label: string;
  collectionName: string;
  listCollectionNames(): Promise<string[]>;
  createCollection(): Promise<void>;
  /** Only ever called when the collection is known to exist. */
  listIndexes(): Promise<ExistingIndexInfo[]>;
  diffSchemaIndexes(): Promise<RegularIndexDiffResult>;
  dropIndexes(names: string[]): Promise<void>;
  createSchemaIndexes(toCreate: RegularIndexSpec[]): Promise<void>;
  /** Omitted for collections with no retention TTL (Tenant, ApiKey, PolicyDocument, CustomerPublicKey). */
  ttl?: {
    field: string;
    expireAfterSeconds: number;
    createIndex(): Promise<void>;
    /** Changes an EXISTING TTL index's expiry via collMod - never drops/recreates the index. */
    updateExpiry(): Promise<void>;
  };
}

export function findSingleFieldTtlIndex(indexes: ExistingIndexInfo[], field: string): ExistingIndexInfo | undefined {
  return indexes.find(
    (idx) => idx.expireAfterSeconds !== undefined && Object.keys(idx.key).length === 1 && idx.key[field] === 1,
  );
}

function indexNameFromKeys(keys: Record<string, number>): string {
  return Object.entries(keys)
    .map(([field, direction]) => `${field}_${direction}`)
    .join('_');
}

function describeIndexToCreate([keys, options]: RegularIndexSpec): string {
  const name = typeof options.name === 'string' ? options.name : indexNameFromKeys(keys);
  return options.unique ? `${name} (unique)` : name;
}

/**
 * Per-index detail for the "existing indexes" log line - unique and TTL
 * expiry are exactly the two properties that distinguish an index from
 * its bare name, and both are easy to get silently wrong in a schema
 * (see learning-notes.md's audit of the redundant tenantId_1 indexes and
 * the unique-flag check this was written for).
 */
function describeExistingIndex(idx: ExistingIndexInfo): string {
  const flags = [idx.unique ? 'unique' : undefined, idx.expireAfterSeconds !== undefined ? `TTL ${idx.expireAfterSeconds}s` : undefined].filter(
    (flag): flag is string => flag !== undefined,
  );
  return flags.length > 0 ? `${idx.name} (${flags.join(', ')})` : idx.name;
}

type TtlAction = { kind: 'none' } | { kind: 'create' } | { kind: 'collMod'; fromSeconds: number | undefined };

function planTtlAction(
  ttl: NonNullable<CollectionIndexDeps['ttl']>,
  existing: ExistingIndexInfo | undefined,
): TtlAction {
  if (!existing) {
    return { kind: 'create' };
  }
  if (existing.expireAfterSeconds !== ttl.expireAfterSeconds) {
    return { kind: 'collMod', fromSeconds: existing.expireAfterSeconds };
  }
  return { kind: 'none' };
}

async function applyTtlAction(
  ttl: NonNullable<CollectionIndexDeps['ttl']>,
  action: TtlAction,
  label: string,
  log: (message: string) => void,
  dryRun: boolean,
): Promise<void> {
  if (action.kind === 'none') {
    log(`${label}: TTL index on "${ttl.field}" already matches (expireAfterSeconds=${ttl.expireAfterSeconds}).`);
    return;
  }
  if (action.kind === 'create') {
    if (dryRun) {
      log(`${label}: [dry-run] would create a TTL index on "${ttl.field}" (expireAfterSeconds=${ttl.expireAfterSeconds}).`);
      return;
    }
    log(`${label}: creating a TTL index on "${ttl.field}" (expireAfterSeconds=${ttl.expireAfterSeconds}).`);
    await ttl.createIndex();
    return;
  }
  if (dryRun) {
    log(
      `${label}: [dry-run] would update the TTL index on "${ttl.field}" from ${action.fromSeconds}s to ${ttl.expireAfterSeconds}s (collMod, no drop).`,
    );
    return;
  }
  log(`${label}: updating the TTL index on "${ttl.field}" from ${action.fromSeconds}s to ${ttl.expireAfterSeconds}s (collMod, no drop).`);
  await ttl.updateExpiry();
}

async function createCollectionTolerant(deps: CollectionIndexDeps, log: (message: string) => void): Promise<void> {
  log(`${deps.label}: collection "${deps.collectionName}" does not exist yet - creating it.`);
  try {
    await deps.createCollection();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/already exists|NamespaceExists/i.test(message)) {
      log(`${deps.label}: collection "${deps.collectionName}" was created by a concurrent process - treating as success.`);
      return;
    }
    throw err;
  }
}

/**
 * One desired index set (schema-declared regular indexes + this
 * collection's TTL index, if any) diffed against one existing-state
 * snapshot, then applied. An unchanged collection logs "already in sync"
 * and performs zero create/drop calls. See the module doc comment above for
 * why this replaced the earlier two-system (`ensureRegularIndexes` +
 * `ensureTtlIndexes`) design.
 */
export async function ensureCollectionIndexes(
  deps: CollectionIndexDeps,
  log: (message: string) => void,
  dryRun = false,
): Promise<void> {
  const existingCollections = await deps.listCollectionNames();
  const exists = existingCollections.includes(deps.collectionName);
  log(`${deps.label}: collection "${deps.collectionName}" ${exists ? 'exists' : 'does not exist yet'}.`);

  const existingIndexes = exists ? await deps.listIndexes() : [];
  log(
    existingIndexes.length > 0
      ? `${deps.label}: existing indexes: ${existingIndexes.map(describeExistingIndex).join(', ')}.`
      : `${deps.label}: no indexes exist yet.`,
  );

  const { toDrop: rawToDrop, toCreate } = await deps.diffSchemaIndexes();

  // Never let the regular-index diff drop the TTL-managed index - this is
  // the fix for the bug described in the module doc comment above.
  const ttlExisting = deps.ttl ? findSingleFieldTtlIndex(existingIndexes, deps.ttl.field) : undefined;
  const toDrop = rawToDrop.filter((name) => name !== ttlExisting?.name);

  const ttlAction: TtlAction = deps.ttl ? planTtlAction(deps.ttl, ttlExisting) : { kind: 'none' };

  const nothingToDo = exists && toDrop.length === 0 && toCreate.length === 0 && ttlAction.kind === 'none';
  if (nothingToDo) {
    log(`${deps.label}: already in sync.`);
    return;
  }

  if (!exists) {
    if (dryRun) {
      log(`${deps.label}: [dry-run] would create the collection.`);
    } else {
      await createCollectionTolerant(deps, log);
    }
  }

  if (toCreate.length > 0) {
    const described = toCreate.map(describeIndexToCreate).join(', ');
    log(`${deps.label}: ${dryRun ? '[dry-run] would create' : 'creating'} index(es): ${described}.`);
    if (!dryRun) {
      await deps.createSchemaIndexes(toCreate);
    }
  }

  if (toDrop.length > 0) {
    log(`${deps.label}: ${dryRun ? '[dry-run] would drop' : 'dropping'} index(es): ${toDrop.join(', ')}.`);
    if (!dryRun) {
      await deps.dropIndexes(toDrop);
    }
  }

  if (deps.ttl) {
    await applyTtlAction(deps.ttl, ttlAction, deps.label, log, dryRun);
  }
}

/**
 * A narrow structural type, not Mongoose's own `Model<T>` generic - same
 * reasoning as `EnsureIndexDeps`'s own doc comment above: `Model<T>`'s
 * internal generic machinery (virtuals, statics, discriminators) makes
 * assigning a concrete model to any re-typed parameter fail to compile,
 * even with every type parameter widened to `any`. Every concrete model
 * built below structurally satisfies this already, since these are exactly
 * the methods `Model` has.
 *
 * mongoose's own `IndexManager` typings (types/indexes.d.ts) type
 * `diffIndexes`'s return and `createIndexes`'s options loosely (`any[]` /
 * `CreateIndexesOptions` with no `toCreate`) because the real
 * `{ toCreate, toDrop }` shape documented in the JS source isn't reflected
 * there - the same gap `listSearchIndexes`/`createSearchIndex` below
 * already route around with a cast.
 */
interface IndexCapableModel {
  createCollection(): Promise<unknown>;
  listIndexes(): Promise<unknown[]>;
  diffIndexes(options?: Record<string, unknown>): Promise<{ toDrop: unknown[]; toCreate: unknown[] }>;
  cleanIndexes(options?: { toDrop?: string[] }): Promise<unknown>;
  createIndexes(options?: Record<string, unknown>): Promise<unknown>;
}

function makeCollectionDeps(
  label: string,
  collectionModel: IndexCapableModel,
  collectionName: string,
  expireAfterSeconds: number,
  ttlField?: string,
): CollectionIndexDeps {
  return {
    label,
    collectionName,
    listCollectionNames: async () => {
      const collections = await mongoose.connection.db!.listCollections({ name: collectionName }).toArray();
      return collections.map((c) => c.name);
    },
    createCollection: async () => {
      await collectionModel.createCollection();
    },
    listIndexes: async () => (await collectionModel.listIndexes()) as unknown as ExistingIndexInfo[],
    diffSchemaIndexes: async () =>
      (await collectionModel.diffIndexes({ indexOptionsToCreate: true })) as unknown as RegularIndexDiffResult,
    dropIndexes: async (names) => {
      await collectionModel.cleanIndexes({ toDrop: names });
    },
    createSchemaIndexes: async (toCreate) => {
      await collectionModel.createIndexes({ toCreate });
    },
    ttl: ttlField
      ? {
          field: ttlField,
          expireAfterSeconds,
          createIndex: async () => {
            await mongoose.connection.db!.collection(collectionName).createIndex({ [ttlField]: 1 }, { expireAfterSeconds });
          },
          updateExpiry: async () => {
            await mongoose.connection.db!.command({
              collMod: collectionName,
              index: { keyPattern: { [ttlField]: 1 }, expireAfterSeconds },
            });
          },
        }
      : undefined,
  };
}

/**
 * Builds every index plan (regular + TTL collections, and the PolicyChunk
 * vector-search deps) against the DEFAULT mongoose connection, which must
 * already be connected. Shared by this script's own `main()` and by the
 * integration test harness (test/integration/ensure-test-indexes.ts) so
 * there is exactly one place that wires schemas to index-management deps -
 * the earlier TTL bug (see the module doc comment on
 * `ensureCollectionIndexes`) came from two independently-maintained copies
 * of this kind of wiring drifting apart; this keeps there from being a
 * second copy to drift.
 */
export function buildIndexPlans(expireAfterSeconds: number): {
  collectionPlans: CollectionIndexDeps[];
  vectorSearchDeps: EnsureIndexDeps;
} {
  const model = mongoose.model('PolicyChunk', PolicyChunkSchema);
  const tenantModel = mongoose.model('Tenant', TenantSchema);
  const apiKeyModel = mongoose.model('ApiKey', ApiKeySchema);
  const policyDocumentModel = mongoose.model('PolicyDocument', PolicyDocumentSchema);
  const conversationModel = mongoose.model('Conversation', ConversationSchema);
  const messageModel = mongoose.model('Message', MessageSchema);
  const agentRunModel = mongoose.model('AgentRun', AgentRunSchema);
  const customerPublicKeyModel = mongoose.model('CustomerPublicKey', CustomerPublicKeySchema);

  const vectorSearchDeps: EnsureIndexDeps = {
    listCollectionNames: async () => {
      const collections = await mongoose.connection.db!.listCollections({ name: COLLECTION_NAME }).toArray();
      return collections.map((c) => c.name);
    },
    createCollection: async () => {
      await model.createCollection();
    },
    listSearchIndexes: async () => (await model.listSearchIndexes()) as unknown as ExistingSearchIndex[],
    createSearchIndex: async (description) =>
      model.createSearchIndex(description as unknown as Parameters<typeof model.createSearchIndex>[0]),
  };

  const collectionPlans: CollectionIndexDeps[] = [
    makeCollectionDeps('Tenant', tenantModel, 'tenants', expireAfterSeconds),
    makeCollectionDeps('ApiKey', apiKeyModel, 'apiKeys', expireAfterSeconds),
    // The vector index itself is handled separately below (vectorSearchDeps/
    // ensureIndexes) - this entry only manages PolicyChunk's three REGULAR
    // field-level indexes (tenantId, documentId, active), the same way every
    // other collection's regular indexes are managed. Runs before
    // ensureIndexes() in main()'s own loop, so on a fresh database this is
    // what actually creates the policyChunks collection; ensureIndexes()
    // then finds it already exists.
    makeCollectionDeps('PolicyChunk', model, 'policyChunks', expireAfterSeconds),
    makeCollectionDeps('PolicyDocument', policyDocumentModel, 'policyDocuments', expireAfterSeconds),
    // Deliberately updatedAt, not createdAt - see the module doc comment above ensureCollectionIndexes.
    makeCollectionDeps('Conversation', conversationModel, 'conversations', expireAfterSeconds, 'updatedAt'),
    makeCollectionDeps('Message', messageModel, 'messages', expireAfterSeconds, 'createdAt'),
    makeCollectionDeps('AgentRun', agentRunModel, 'agentRuns', expireAfterSeconds, 'createdAt'),
    makeCollectionDeps('CustomerPublicKey', customerPublicKeyModel, 'customerPublicKeys', expireAfterSeconds),
  ];

  return { collectionPlans, vectorSearchDeps };
}

async function main(): Promise<void> {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    console.error('MONGODB_URI is not set.');
    process.exitCode = 1;
    return;
  }

  const allowTestDb = process.argv.includes('--allow-test-db');
  const dryRun = process.argv.includes('--dry-run');
  try {
    assertNotTestDatabase(uri, allowTestDb);
  } catch (err) {
    console.error((err as Error).message);
    process.exitCode = 1;
    return;
  }

  console.log(`Target database: "${getDatabaseNameFromUri(uri)}"`);
  console.log(`Target collection: "${COLLECTION_NAME}"`);
  if (dryRun) {
    console.log('Mode: --dry-run (no changes will be made)');
  }

  await mongoose.connect(uri);
  const retentionDays = Number(process.env.CHAT_RETENTION_DAYS ?? 30);
  const expireAfterSeconds = retentionDays * 24 * 60 * 60;
  const { collectionPlans, vectorSearchDeps } = buildIndexPlans(expireAfterSeconds);

  try {
    console.log(`Retention: ${retentionDays} day(s) (CHAT_RETENTION_DAYS) - expireAfterSeconds=${expireAfterSeconds}.`);
    for (const plan of collectionPlans) {
      await ensureCollectionIndexes(plan, (message) => console.log(message), dryRun);
    }
    await ensureIndexes(vectorSearchDeps, (message) => console.log(message), dryRun);
  } finally {
    await mongoose.disconnect();
  }
}

if (require.main === module) {
  main().catch((err: unknown) => {
    console.error('db:ensure-indexes failed:', err instanceof Error ? err.message : err);
    process.exitCode = 1;
  });
}
