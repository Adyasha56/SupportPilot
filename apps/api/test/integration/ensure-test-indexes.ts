/**
 * Reuses the exact same index-management functions the db:ensure-indexes
 * script uses (src/scripts/db-ensure-indexes.ts) against the one fixed
 * test database, so the integration suite never duplicates that logic and
 * is proven to set up the test database the identical way a developer
 * would via `pnpm run db:ensure-indexes -- --allow-test-db` (Stage 7 item 5).
 *
 * Called exactly once, from global-setup.ts's vitest globalSetup hook -
 * NOT from individual spec files' beforeAll. That per-file approach was
 * the original design and raced for real in CI: vitest runs each spec
 * file in its own worker process, so a module-level "only once" guard
 * like the one below only protects one file at a time, and two files
 * simultaneously calling the real, non-idempotent createSearchIndex
 * produced "duplicate index names" (see global-setup.ts and
 * docs/learning-notes.md). The `ensured` guard below stays as cheap
 * defense-in-depth against a future accidental second call within the
 * same process, not as the actual concurrency guarantee - that guarantee
 * is globalSetup running once, in one process, before any worker spawns.
 *
 * Stage 4, Stage 2 item 5: this previously called ONLY ensureIndexes (the
 * Atlas Vector Search index on PolicyChunk) - a real gap, not just for the
 * four new chat collections but for every model: the unique index on
 * ApiKey.hash, the lookup indexes on PolicyDocument, etc. were never
 * actually created in the test database at all. Now calls
 * ensureRegularIndexes (every model, same list main() uses) and
 * ensureTtlIndexes (Message/AgentRun/Conversation, amendment E) too, so
 * the integration suite exercises the exact same index set a real
 * deployment would have - including the CustomerPublicKey unique index
 * tests for duplicate-kid rejection would otherwise never actually prove.
 */
import mongoose from 'mongoose';
import { assertIsTestDatabase } from '../../src/db/database-name';
import {
  ensureIndexes,
  ensureRegularIndexes,
  ensureTtlIndexes,
  EnsureIndexDeps,
  RegularIndexModel,
  TtlIndexDeps,
  TtlIndexSpec,
} from '../../src/scripts/db-ensure-indexes';
import { PolicyChunkSchema } from '../../src/db/schemas/policy-chunk.schema';
import { TenantSchema } from '../../src/db/schemas/tenant.schema';
import { ApiKeySchema } from '../../src/db/schemas/api-key.schema';
import { PolicyDocumentSchema } from '../../src/db/schemas/policy-document.schema';
import { ConversationSchema } from '../../src/db/schemas/conversation.schema';
import { MessageSchema } from '../../src/db/schemas/message.schema';
import { AgentRunSchema } from '../../src/db/schemas/agent-run.schema';
import { CustomerPublicKeySchema } from '../../src/db/schemas/customer-public-key.schema';

let ensured = false;

export async function ensureTestIndexes(uri: string, log: (message: string) => void = () => {}): Promise<void> {
  if (ensured) {
    return;
  }
  assertIsTestDatabase(uri);
  await mongoose.connect(uri);

  const model = mongoose.model('PolicyChunk', PolicyChunkSchema);
  const tenantModel = mongoose.model('Tenant', TenantSchema);
  const apiKeyModel = mongoose.model('ApiKey', ApiKeySchema);
  const policyDocumentModel = mongoose.model('PolicyDocument', PolicyDocumentSchema);
  const conversationModel = mongoose.model('Conversation', ConversationSchema);
  const messageModel = mongoose.model('Message', MessageSchema);
  const agentRunModel = mongoose.model('AgentRun', AgentRunSchema);
  const customerPublicKeyModel = mongoose.model('CustomerPublicKey', CustomerPublicKeySchema);

  const regularIndexModels: RegularIndexModel[] = [
    { name: 'Tenant', diffIndexes: () => tenantModel.diffIndexes(), syncIndexes: () => tenantModel.syncIndexes() },
    { name: 'ApiKey', diffIndexes: () => apiKeyModel.diffIndexes(), syncIndexes: () => apiKeyModel.syncIndexes() },
    {
      name: 'PolicyDocument',
      diffIndexes: () => policyDocumentModel.diffIndexes(),
      syncIndexes: () => policyDocumentModel.syncIndexes(),
    },
    { name: 'PolicyChunk', diffIndexes: () => model.diffIndexes(), syncIndexes: () => model.syncIndexes() },
    {
      name: 'Conversation',
      diffIndexes: () => conversationModel.diffIndexes(),
      syncIndexes: () => conversationModel.syncIndexes(),
    },
    { name: 'Message', diffIndexes: () => messageModel.diffIndexes(), syncIndexes: () => messageModel.syncIndexes() },
    { name: 'AgentRun', diffIndexes: () => agentRunModel.diffIndexes(), syncIndexes: () => agentRunModel.syncIndexes() },
    {
      name: 'CustomerPublicKey',
      diffIndexes: () => customerPublicKeyModel.diffIndexes(),
      syncIndexes: () => customerPublicKeyModel.syncIndexes(),
    },
  ];

  const deps: EnsureIndexDeps = {
    listCollectionNames: async () => {
      const collections = await mongoose.connection.db!.listCollections({ name: 'policyChunks' }).toArray();
      return collections.map((c) => c.name);
    },
    createCollection: async () => {
      await model.createCollection();
    },
    listSearchIndexes: async () => (await model.listSearchIndexes()) as unknown as Awaited<ReturnType<EnsureIndexDeps['listSearchIndexes']>>,
    createSearchIndex: async (description) =>
      model.createSearchIndex(description as unknown as Parameters<typeof model.createSearchIndex>[0]),
  };

  // A short, fixed retention period in tests - exercising the real
  // ensureTtlIndexes code path (and the real index it creates) without
  // needing CHAT_RETENTION_DAYS set; the integration tests only check the
  // index's existence/shape, never wait out a real 30-day expiry.
  const testExpireAfterSeconds = 30 * 24 * 60 * 60;
  const ttlSpecs: TtlIndexSpec[] = [
    { label: 'Message', collectionName: 'messages', field: 'createdAt', expireAfterSeconds: testExpireAfterSeconds },
    { label: 'AgentRun', collectionName: 'agentRuns', field: 'createdAt', expireAfterSeconds: testExpireAfterSeconds },
    { label: 'Conversation', collectionName: 'conversations', field: 'updatedAt', expireAfterSeconds: testExpireAfterSeconds },
  ];
  const ttlDeps: TtlIndexDeps = {
    listIndexes: async (collectionName) =>
      (await mongoose.connection.db!.collection(collectionName).indexes()) as unknown as Awaited<ReturnType<TtlIndexDeps['listIndexes']>>,
    createTtlIndex: async (collectionName, field, seconds) => {
      await mongoose.connection.db!.collection(collectionName).createIndex({ [field]: 1 }, { expireAfterSeconds: seconds });
    },
    updateTtlIndexExpiry: async (collectionName, field, seconds) => {
      await mongoose.connection.db!.command({ collMod: collectionName, index: { keyPattern: { [field]: 1 }, expireAfterSeconds: seconds } });
    },
  };

  await ensureRegularIndexes(regularIndexModels, log);
  await ensureIndexes(deps, log);
  await ensureTtlIndexes(ttlSpecs, ttlDeps, log);
  ensured = true;
}
