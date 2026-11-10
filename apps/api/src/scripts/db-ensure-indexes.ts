/**
 * Manually run only - never from the app's own boot path (see
 * database.module.ts). Run once per database (dev, and separately the one
 * fixed test database, which needs --allow-test-db):
 *
 *   pnpm run db:ensure-indexes
 *   pnpm run db:ensure-indexes -- --allow-test-db   (for the shared test db)
 *   pnpm run db:ensure-indexes -- --dry-run         (prints the plan, changes nothing)
 *   pnpm run db:ensure-indexes -- --migrate-approval-ttl   (amendment F3, see below)
 *
 * --dry-run still connects and reads real state (so the plan it prints is
 * accurate), and the test_ database guard still applies to it - a dry-run
 * is not an exemption from that guard, only from making changes.
 *
 * --migrate-approval-ttl is a SEPARATE, explicit, protected flag for one
 * specific operation MongoDB cannot do via the normal collMod path: Approval's
 * TTL index's partialFilterExpression changed (amendment F3, active:false
 * only) in a way that a database whose TTL index predates that change can
 * never reach through the ordinary create/collMod flow - a plain TTL index's
 * filter can only become partial via drop+recreate, never collMod. Without
 * this flag, that mismatch STOPS the whole run with a clear error (checked
 * unconditionally, dry-run or not, before any other index work on that
 * collection) rather than ever being auto-applied. With it, the migration
 * still refuses to run if any Approval document has active:true.
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
import { APPROVAL_ACTIVE_ORDER_UNIQUE_INDEX_NAME, ApprovalSchema } from '../approvals/schemas/approval.schema';

export const COLLECTION_NAME = 'policyChunks';
export const POLL_INTERVAL_MS = 10_000;
export const QUERYABLE_TIMEOUT_MS = 120_000;

/**
 * Milestone 4 - validated, unlike CHAT_RETENTION_DAYS's existing bare
 * `Number(...)` read (left as-is; not this task's scope to change). A
 * malformed or non-positive APPROVAL_RETENTION_DAYS must fail loudly here
 * rather than silently compute a nonsensical expireAfterSeconds (NaN, or
 * zero/negative, which MongoDB would otherwise accept literally).
 */
export function resolveRetentionDays(envValue: string | undefined, defaultValue: number, envName: string): number {
  if (envValue === undefined) {
    return defaultValue;
  }
  const value = Number(envValue);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${envName} must be a positive integer number of days; got "${envValue}".`);
  }
  return value;
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
  /** Milestone 4 amendment C - present only on a partial index (e.g. the Approval active-per-order unique index). */
  partialFilterExpression?: Record<string, unknown>;
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
    /** Milestone 4 amendment F3 - only Approval sets this (partial TTL on active:false, so an unresolved approval is never deleted while it's still blocking). Undefined means a plain, unfiltered TTL index, same as every other collection. */
    partialFilterExpression?: Record<string, unknown>;
    createIndex(): Promise<void>;
    /** Changes an EXISTING TTL index's expiry via collMod - never drops/recreates the index. */
    updateExpiry(): Promise<void>;
    /**
     * Amendment F3's explicit, protected migration path - only wired when
     * `partialFilterExpression` is set, since that's the only case MongoDB
     * can't collMod its way out of (expireAfterSeconds can change in
     * place; partialFilterExpression cannot). Never invoked unless the
     * caller passed the explicit CLI flag AND countBlocking() returns 0.
     */
    migrate?: {
      /** Documents that must be zero before a drop+recreate is safe (e.g. any approval with active:true). */
      countBlocking(): Promise<number>;
      dropAndRecreate(existingIndexName: string): Promise<void>;
    };
  };
  /** Milestone 4 amendment C - indexes that must error rather than be auto-dropped-and-recreated on a mismatch. See checkProtectedIndexes' own doc comment. */
  protectedIndexes?: ProtectedIndexSpec[];
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
  const flags = [
    options.unique ? 'unique' : undefined,
    options.partialFilterExpression ? `partial: ${JSON.stringify(options.partialFilterExpression)}` : undefined,
  ].filter((flag): flag is string => flag !== undefined);
  return flags.length > 0 ? `${name} (${flags.join(', ')})` : name;
}

/**
 * Per-index detail for the "existing indexes" log line - unique, TTL
 * expiry, and (Milestone 4 amendment C) a partial filter expression are
 * exactly the properties that distinguish an index from its bare name,
 * and all are easy to get silently wrong in a schema (see
 * learning-notes.md's audit of the redundant tenantId_1 indexes and the
 * unique-flag check this was written for).
 */
function describeExistingIndex(idx: ExistingIndexInfo): string {
  const flags = [
    idx.unique ? 'unique' : undefined,
    idx.expireAfterSeconds !== undefined ? `TTL ${idx.expireAfterSeconds}s` : undefined,
    idx.partialFilterExpression ? `partial: ${JSON.stringify(idx.partialFilterExpression)}` : undefined,
  ].filter((flag): flag is string => flag !== undefined);
  return flags.length > 0 ? `${idx.name} (${flags.join(', ')})` : idx.name;
}

/** Plain structural equality for JSON-safe filter objects - order-independent on keys, which is all a partialFilterExpression ever needs (it's never deeply nested in this project's own usage). */
function partialFilterExpressionsEqual(a: Record<string, unknown> | undefined, b: Record<string, unknown> | undefined): boolean {
  if (!a || !b) {
    return a === b;
  }
  const aKeys = Object.keys(a).sort();
  const bKeys = Object.keys(b).sort();
  if (aKeys.length !== bKeys.length || aKeys.some((k, i) => k !== bKeys[i])) {
    return false;
  }
  return aKeys.every((k) => a[k] === b[k]);
}

/**
 * Milestone 4 amendment C - a regular index this script must NEVER
 * auto-drop-and-recreate just because diffIndexes() thinks its options
 * changed, the same protection the TTL index already gets (see this
 * file's own module doc comment), extended here to cover `unique` and
 * `partialFilterExpression` rather than `expireAfterSeconds`. A real
 * mismatch is a validation finding, not a mutation this script performs
 * automatically - exactly like the PolicyChunk vector index's own
 * definitionsMatch check - because changing a UNIQUE partial index's
 * filter on a collection that already has live data can only be done
 * safely by hand (a blind drop briefly removes the uniqueness guarantee;
 * a blind recreate can fail outright if documents violating the NEW
 * filter already exist).
 */
export interface ProtectedIndexSpec {
  name: string;
  expectedUnique: boolean;
  expectedPartialFilterExpression: Record<string, unknown>;
}

export function checkProtectedIndexes(existingIndexes: ExistingIndexInfo[], protectedIndexes: ProtectedIndexSpec[]): void {
  for (const spec of protectedIndexes) {
    const existing = existingIndexes.find((idx) => idx.name === spec.name);
    if (!existing) {
      continue; // doesn't exist yet - diffSchemaIndexes()'s own toCreate handles this normally.
    }
    const matches =
      Boolean(existing.unique) === spec.expectedUnique &&
      partialFilterExpressionsEqual(existing.partialFilterExpression, spec.expectedPartialFilterExpression);
    if (!matches) {
      throw new Error(
        `Index "${spec.name}" already exists but its unique flag or partialFilterExpression does not match the ` +
          'expected definition. Not auto-fixing - resolve this manually (changing a partial unique index\'s filter ' +
          'on a collection with live data needs a careful, deliberate migration, never an automated drop+recreate).',
      );
    }
  }
}

type TtlAction =
  | { kind: 'none' }
  | { kind: 'create' }
  | { kind: 'collMod'; fromSeconds: number | undefined }
  | { kind: 'filter_mismatch'; existing: ExistingIndexInfo };

/**
 * partialFilterExpression is checked FIRST and takes priority over
 * expireAfterSeconds - MongoDB can collMod expireAfterSeconds on an
 * existing TTL index in place, but it cannot change partialFilterExpression
 * that way at all, so a filter mismatch is never just "also apply a
 * collMod" - it's a different, far more careful operation (amendment F3).
 */
function planTtlAction(ttl: NonNullable<CollectionIndexDeps['ttl']>, existing: ExistingIndexInfo | undefined): TtlAction {
  if (!existing) {
    return { kind: 'create' };
  }
  if (!partialFilterExpressionsEqual(existing.partialFilterExpression, ttl.partialFilterExpression)) {
    return { kind: 'filter_mismatch', existing };
  }
  if (existing.expireAfterSeconds !== ttl.expireAfterSeconds) {
    return { kind: 'collMod', fromSeconds: existing.expireAfterSeconds };
  }
  return { kind: 'none' };
}

/** The exact command this file's own error message and `main()`'s --help-equivalent output both point operators at - kept in one place so they can never drift apart. */
export function migrateCommandFor(label: string): string {
  return `pnpm run db:ensure-indexes -- --migrate-${label.toLowerCase()}-ttl`;
}

async function applyTtlAction(
  ttl: NonNullable<CollectionIndexDeps['ttl']>,
  action: TtlAction,
  label: string,
  log: (message: string) => void,
  dryRun: boolean,
  allowTtlMigration: boolean,
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
  if (action.kind === 'collMod') {
    if (dryRun) {
      log(
        `${label}: [dry-run] would update the TTL index on "${ttl.field}" from ${action.fromSeconds}s to ${ttl.expireAfterSeconds}s (collMod, no drop).`,
      );
      return;
    }
    log(`${label}: updating the TTL index on "${ttl.field}" from ${action.fromSeconds}s to ${ttl.expireAfterSeconds}s (collMod, no drop).`);
    await ttl.updateExpiry();
    return;
  }

  // action.kind === 'filter_mismatch' - amendment F3. Always evaluated, dry-run or not, same as
  // checkProtectedIndexes above: this is a validation finding this script never auto-fixes
  // without the explicit flag, never a mutation --dry-run alone would defer.
  const migrateCommand = migrateCommandFor(label);
  const existingFilterText = JSON.stringify(action.existing.partialFilterExpression ?? null);
  const desiredFilterText = JSON.stringify(ttl.partialFilterExpression ?? null);
  if (!allowTtlMigration) {
    throw new Error(
      `${label}: TTL index "${action.existing.name}" on "${ttl.field}" has partialFilterExpression ${existingFilterText} but the ` +
        `desired definition requires ${desiredFilterText}. MongoDB cannot change a TTL index's partialFilterExpression via collMod ` +
        `(only expireAfterSeconds can be changed in place) - resolve with an explicit, protected migration: run '${migrateCommand}' ` +
        '(add --allow-test-db too if targeting the test database). That migration refuses to run if any document still has active:true.',
    );
  }
  if (!ttl.migrate) {
    throw new Error(`${label}: a migration flag was passed but this collection's plan has no migrate configuration for its TTL index.`);
  }
  if (dryRun) {
    log(
      `${label}: [dry-run] would check for any blocking document (active:true), then drop index "${action.existing.name}" and recreate ` +
        `it on "${ttl.field}" with partialFilterExpression ${desiredFilterText} (expireAfterSeconds=${ttl.expireAfterSeconds}).`,
    );
    return;
  }
  const blockingCount = await ttl.migrate.countBlocking();
  if (blockingCount > 0) {
    throw new Error(
      `${label}: refusing to migrate the TTL index - ${blockingCount} document(s) still have active:true. Resolve those first ` +
        '(they must reach a terminal state) before migrating.',
    );
  }
  log(
    `${label}: migrating TTL index "${action.existing.name}" on "${ttl.field}" (drop + recreate with partialFilterExpression ` +
      `${desiredFilterText}) - 0 blocking documents, safe to proceed.`,
  );
  await ttl.migrate.dropAndRecreate(action.existing.name);
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
  allowTtlMigration = false,
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

  // Always checked, dry-run or not, and BEFORE any other index work for this collection -
  // a mismatch is a validation finding this script STOPS on, never a mutation it performs or
  // defers, same as the vector index's own definitionsMatch check below.
  if (deps.protectedIndexes) {
    checkProtectedIndexes(existingIndexes, deps.protectedIndexes);
  }

  const ttlExisting = deps.ttl ? findSingleFieldTtlIndex(existingIndexes, deps.ttl.field) : undefined;
  const ttlAction: TtlAction = deps.ttl ? planTtlAction(deps.ttl, ttlExisting) : { kind: 'none' };
  if (ttlAction.kind === 'filter_mismatch' && !allowTtlMigration) {
    // Stop here, before touching this collection's regular indexes at all - applyTtlAction
    // throws the actual, detailed message; this just ensures it fires first, every time.
    await applyTtlAction(deps.ttl!, ttlAction, deps.label, log, dryRun, allowTtlMigration);
  }

  const { toDrop: rawToDrop, toCreate } = await deps.diffSchemaIndexes();

  // Never let the regular-index diff drop the TTL-managed index, or a protected index (Milestone
  // 4 amendment C) - this is the fix for the bug described in the module doc comment above,
  // extended to cover the second kind of index this script must never auto-drop-and-recreate.
  const protectedNames = new Set((deps.protectedIndexes ?? []).map((p) => p.name));
  const toDrop = rawToDrop.filter((name) => name !== ttlExisting?.name && !protectedNames.has(name));

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
    await applyTtlAction(deps.ttl, ttlAction, deps.label, log, dryRun, allowTtlMigration);
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

interface MakeCollectionDepsTtlOptions {
  /** Amendment F3 - only Approval sets this. Wiring `migrate` below is unconditional on this being set; WHETHER it's actually allowed to run is gated separately, by the `allowTtlMigration` flag threaded through ensureCollectionIndexes/applyTtlAction. */
  partialFilterExpression?: Record<string, unknown>;
}

function makeCollectionDeps(
  label: string,
  collectionModel: IndexCapableModel,
  collectionName: string,
  expireAfterSeconds: number,
  ttlField?: string,
  protectedIndexes?: ProtectedIndexSpec[],
  ttlOptions?: MakeCollectionDepsTtlOptions,
): CollectionIndexDeps {
  return {
    label,
    collectionName,
    protectedIndexes,
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
          partialFilterExpression: ttlOptions?.partialFilterExpression,
          createIndex: async () => {
            await mongoose.connection.db!.collection(collectionName).createIndex(
              { [ttlField]: 1 },
              { expireAfterSeconds, ...(ttlOptions?.partialFilterExpression ? { partialFilterExpression: ttlOptions.partialFilterExpression } : {}) },
            );
          },
          updateExpiry: async () => {
            await mongoose.connection.db!.command({
              collMod: collectionName,
              index: { keyPattern: { [ttlField]: 1 }, expireAfterSeconds },
            });
          },
          migrate: ttlOptions?.partialFilterExpression
            ? {
                countBlocking: async () => mongoose.connection.db!.collection(collectionName).countDocuments({ active: true }),
                dropAndRecreate: async (existingIndexName: string) => {
                  await mongoose.connection.db!.collection(collectionName).dropIndex(existingIndexName);
                  await mongoose.connection.db!.collection(collectionName).createIndex(
                    { [ttlField]: 1 },
                    { expireAfterSeconds, partialFilterExpression: ttlOptions.partialFilterExpression },
                  );
                },
              }
            : undefined,
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
export function buildIndexPlans(
  expireAfterSeconds: number,
  approvalExpireAfterSeconds: number = expireAfterSeconds,
): {
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
  const approvalModel = mongoose.model('Approval', ApprovalSchema);

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
    // Milestone 4 amendment C - its own retention period (APPROVAL_RETENTION_DAYS, default 90,
    // longer than CHAT_RETENTION_DAYS - an approval is an audit/compliance record), and the
    // protected partial unique index that must error rather than auto-drop-and-recreate on a
    // mismatch (checkProtectedIndexes, above). Amendment F3 - the TTL itself is ALSO partial
    // (active: false), so an unresolved approval is never deleted while it's still blocking a
    // fresh proposal for its order; changing that filter on an existing plain TTL index needs
    // the explicit --migrate-approval-ttl path (applyTtlAction's filter_mismatch branch).
    makeCollectionDeps(
      'Approval',
      approvalModel,
      'approvals',
      approvalExpireAfterSeconds,
      'createdAt',
      [
        {
          name: APPROVAL_ACTIVE_ORDER_UNIQUE_INDEX_NAME,
          expectedUnique: true,
          expectedPartialFilterExpression: { active: true },
        },
      ],
      { partialFilterExpression: { active: false } },
    ),
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
  // Amendment F3's explicit, protected migration flag - see applyTtlAction's filter_mismatch
  // branch for what this actually gates (a drop+recreate of Approval's TTL index, refused
  // outright if any document still has active:true).
  const migrateApprovalTtl = process.argv.includes('--migrate-approval-ttl');
  let approvalRetentionDays: number;
  try {
    assertNotTestDatabase(uri, allowTestDb);
    approvalRetentionDays = resolveRetentionDays(process.env.APPROVAL_RETENTION_DAYS, 90, 'APPROVAL_RETENTION_DAYS');
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
  const approvalExpireAfterSeconds = approvalRetentionDays * 24 * 60 * 60;
  const { collectionPlans, vectorSearchDeps } = buildIndexPlans(expireAfterSeconds, approvalExpireAfterSeconds);

  try {
    console.log(`Retention: ${retentionDays} day(s) (CHAT_RETENTION_DAYS) - expireAfterSeconds=${expireAfterSeconds}.`);
    console.log(`Retention: ${approvalRetentionDays} day(s) (APPROVAL_RETENTION_DAYS) - expireAfterSeconds=${approvalExpireAfterSeconds}.`);
    for (const plan of collectionPlans) {
      // migrateApprovalTtl only has any effect on the Approval plan (the only one with a
      // partialFilterExpression TTL) - harmless to pass unconditionally to every other plan.
      await ensureCollectionIndexes(plan, (message) => console.log(message), dryRun, migrateApprovalTtl);
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
