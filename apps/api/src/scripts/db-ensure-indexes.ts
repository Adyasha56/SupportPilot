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

export const COLLECTION_NAME = 'policyChunks';
export const POLL_INTERVAL_MS = 10_000;
export const QUERYABLE_TIMEOUT_MS = 120_000;

export interface RegularIndexModel {
  name: string;
  diffIndexes(): Promise<{ toDrop: string[]; toCreate: string[] }>;
  syncIndexes(): Promise<string[]>;
}

/**
 * Regular (non-Atlas-Search) index management for every schema - e.g. the
 * unique index on ApiKey.hash. Mongoose's autoIndex is set to false (see
 * database.module.ts) so these are never built implicitly at app boot;
 * syncIndexes() is the documented replacement, run manually, here, next to
 * the Atlas Vector Search index management below - one script owns all
 * index creation for the whole database.
 *
 * diffIndexes() is called first (even outside --dry-run) so every created
 * or dropped index name is logged explicitly - syncIndexes()'s own return
 * value only reports what it dropped, not what it created.
 */
export async function ensureRegularIndexes(
  models: RegularIndexModel[],
  log: (message: string) => void,
  options: { dryRun: boolean } = { dryRun: false },
): Promise<void> {
  for (const model of models) {
    const { toDrop, toCreate } = await model.diffIndexes();
    if (toDrop.length === 0 && toCreate.length === 0) {
      log(`${model.name}: regular indexes already in sync with the schema.`);
      continue;
    }
    if (toCreate.length > 0) {
      log(`${model.name}: ${options.dryRun ? '[dry-run] would create' : 'creating'} index(es): ${toCreate.join(', ')}`);
    }
    if (toDrop.length > 0) {
      log(`${model.name}: ${options.dryRun ? '[dry-run] would drop' : 'dropping'} index(es): ${toDrop.join(', ')}`);
    }
    if (!options.dryRun) {
      await model.syncIndexes();
    }
  }
}

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
  const model = mongoose.model('PolicyChunk', PolicyChunkSchema);
  const tenantModel = mongoose.model('Tenant', TenantSchema);
  const apiKeyModel = mongoose.model('ApiKey', ApiKeySchema);
  const policyDocumentModel = mongoose.model('PolicyDocument', PolicyDocumentSchema);

  const regularIndexModels: RegularIndexModel[] = [
    { name: 'Tenant', diffIndexes: () => tenantModel.diffIndexes(), syncIndexes: () => tenantModel.syncIndexes() },
    { name: 'ApiKey', diffIndexes: () => apiKeyModel.diffIndexes(), syncIndexes: () => apiKeyModel.syncIndexes() },
    {
      name: 'PolicyDocument',
      diffIndexes: () => policyDocumentModel.diffIndexes(),
      syncIndexes: () => policyDocumentModel.syncIndexes(),
    },
    { name: 'PolicyChunk', diffIndexes: () => model.diffIndexes(), syncIndexes: () => model.syncIndexes() },
  ];

  const deps: EnsureIndexDeps = {
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

  try {
    await ensureRegularIndexes(regularIndexModels, (message) => console.log(message), { dryRun });
    await ensureIndexes(deps, (message) => console.log(message), dryRun);
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
