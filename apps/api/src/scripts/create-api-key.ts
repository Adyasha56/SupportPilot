/**
 * Manually run only. Runs compiled JS, same reasoning as db-ensure-indexes
 * (decorators and constructor parameter properties aren't supported by
 * Node's native TypeScript type stripping - see that script's header).
 *
 *   pnpm run create-api-key -- --tenantId=acme --name="Acme Inc" [--scope=secret]
 *   pnpm run create-api-key -- --revoke=<apiKeyId>
 *
 * Refuses to run against what looks like the shared test database unless
 * --allow-test-db is passed, same as db-ensure-indexes.
 */
import mongoose from 'mongoose';
import { TENANT_ID_PATTERN } from '@supportpilot/shared';
import { generateRawApiKey, getKeyPrefix, hashApiKey } from '../auth/api-key.service';
import { assertNotTestDatabase } from '../db/database-name';
import { ApiKeySchema, ApiKeyScope } from '../db/schemas/api-key.schema';
import { TenantSchema } from '../db/schemas/tenant.schema';
import { DEMO_TENANT_SETTINGS } from '../db/tenant.repository';

function parseArgs(argv: string[]): Record<string, string | boolean> {
  const args: Record<string, string | boolean> = {};
  for (const arg of argv) {
    if (!arg.startsWith('--')) continue;
    const [key, value] = arg.slice(2).split('=');
    args[key] = value ?? true;
  }
  return args;
}

async function runCreate(args: Record<string, string | boolean>): Promise<void> {
  const tenantId = args.tenantId;
  if (typeof tenantId !== 'string' || !TENANT_ID_PATTERN.test(tenantId)) {
    throw new Error(
      '--tenantId is required and must match the shared tenant id pattern (lowercase letters, digits, "-", "_", max 32 chars).',
    );
  }
  const name = typeof args.name === 'string' ? args.name : tenantId;
  const scope: ApiKeyScope = args.scope === 'public' ? 'public' : 'secret';

  const TenantModel = mongoose.model('Tenant', TenantSchema);
  const ApiKeyModel = mongoose.model('ApiKey', ApiKeySchema);

  await TenantModel.findByIdAndUpdate(
    tenantId,
    { $setOnInsert: { _id: tenantId, name, settings: DEMO_TENANT_SETTINGS } },
    { upsert: true },
  );

  const rawKey = generateRawApiKey();
  const hash = hashApiKey(rawKey);
  const keyPrefix = getKeyPrefix(rawKey);

  const created = await ApiKeyModel.create({ tenantId, hash, keyPrefix, scopes: [scope], revokedAt: null });

  // The raw key is printed exactly once, here, and nowhere else - never logged elsewhere, never stored.
  console.log('API key created. Save this now - it will not be shown again:');
  console.log(rawKey);
  console.log(`\nKey id (safe to record, used for revocation): ${created._id.toString()}`);
  console.log(`Tenant: ${tenantId}`);
  console.log(`Scope: ${scope}`);
}

async function runRevoke(id: string): Promise<void> {
  const ApiKeyModel = mongoose.model('ApiKey', ApiKeySchema);
  const result = await ApiKeyModel.updateOne({ _id: id, revokedAt: null }, { $set: { revokedAt: new Date() } });
  if (result.modifiedCount === 0) {
    throw new Error(`No active key found with id "${id}" (already revoked, or id does not exist).`);
  }
  console.log(`Key ${id} revoked.`);
}

async function main(): Promise<void> {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    console.error('MONGODB_URI is not set.');
    process.exitCode = 1;
    return;
  }

  const args = parseArgs(process.argv.slice(2));
  assertNotTestDatabase(uri, args['allow-test-db'] === true);

  await mongoose.connect(uri);
  try {
    if (typeof args.revoke === 'string') {
      await runRevoke(args.revoke);
    } else {
      await runCreate(args);
    }
  } finally {
    await mongoose.disconnect();
  }
}

main().catch((err: unknown) => {
  console.error('create-api-key failed:', err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
