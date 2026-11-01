/**
 * Manual only, destructive - deletes one scratch tenant's policy documents
 * and chunks from the real database MONGODB_URI points at. Exists because
 * the manual smoke/quality scripts (retrieval-smoke-test.ts,
 * retrieval-quality-check.ts, agent-pipeline-smoke-test.ts) each clean up
 * their own scratch tenant in a `finally` block, but a crash BEFORE that
 * `finally` runs (or a killed process) can still leave scratch data behind.
 * This is the manual fallback for exactly that case.
 *
 * Refuses to touch anything that isn't an obvious scratch tenant id - one
 * of this project's own scripts' own id prefixes (`rq-`, `pipe-`,
 * `smoke-`) - so a typo can never delete a real tenant's policy data.
 * Also refuses to run against a database name starting with "test_"
 * unless --allow-test-db is passed, same guard as every other script here.
 *
 *   pnpm run delete-scratch-tenant -- <tenantId>
 */
import mongoose from 'mongoose';
import { assertNotTestDatabase, getDatabaseNameFromUri } from '../db/database-name';
import { MongoosePolicyChunkRepository } from '../db/policy-chunk.repository';
import { PolicyChunkDocument, PolicyChunkSchema } from '../db/schemas/policy-chunk.schema';
import { PolicyDocumentDocument, PolicyDocumentSchema } from '../db/schemas/policy-document.schema';

/** The exact id prefixes this project's own manual scripts generate scratch tenants under - see retrieval-smoke-test.ts, retrieval-quality-check.ts, agent-pipeline-smoke-test.ts. */
const SCRATCH_TENANT_PREFIXES = ['rq-', 'pipe-', 'smoke-'];

function isScratchTenantId(tenantId: string): boolean {
  return SCRATCH_TENANT_PREFIXES.some((prefix) => tenantId.startsWith(prefix));
}

async function main(): Promise<void> {
  const tenantId = process.argv[2];
  if (!tenantId) {
    console.error('Usage: pnpm run delete-scratch-tenant -- <tenantId>');
    process.exitCode = 1;
    return;
  }
  if (!isScratchTenantId(tenantId)) {
    console.error(
      `Refusing to delete "${tenantId}" - it does not start with one of this project's own scratch-tenant prefixes (${SCRATCH_TENANT_PREFIXES.join(', ')}). This script only ever deletes data for a tenant id that is obviously one of this project's own throwaway scratch tenants.`,
    );
    process.exitCode = 1;
    return;
  }

  const uri = process.env.MONGODB_URI;
  if (!uri) {
    console.error('MONGODB_URI is not set.');
    process.exitCode = 1;
    return;
  }
  try {
    assertNotTestDatabase(uri, process.argv.includes('--allow-test-db'));
  } catch (err) {
    console.error((err as Error).message);
    process.exitCode = 1;
    return;
  }
  console.log(`Target database: "${getDatabaseNameFromUri(uri)}"`);
  console.log(`Deleting all policy documents/chunks for scratch tenant "${tenantId}"...`);

  await mongoose.connect(uri);
  try {
    const chunkModel = mongoose.model<PolicyChunkDocument>('PolicyChunk', PolicyChunkSchema);
    const documentModel = mongoose.model<PolicyDocumentDocument>('PolicyDocument', PolicyDocumentSchema);
    const chunkRepository = new MongoosePolicyChunkRepository(chunkModel);

    await chunkRepository.deleteForTenant(tenantId);
    const documentDeleteResult = await documentModel.deleteMany({ tenantId });

    console.log(`Deleted ${documentDeleteResult.deletedCount} document(s) and their chunks for tenant "${tenantId}".`);
  } finally {
    await mongoose.disconnect();
  }
}

main().catch((err: unknown) => {
  console.error('delete-scratch-tenant failed:', err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
