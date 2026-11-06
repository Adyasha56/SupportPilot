/**
 * Manually run only. Runs compiled JS, same reasoning as create-api-key.ts.
 *
 *   pnpm run register-customer-key -- --tenantId=acme --kid=1 --publicKeyX=<base64url-jwk-x>
 *   pnpm run register-customer-key -- --tenantId=acme --retire=1
 *
 * The company generates its own Ed25519 keypair and gives us only the
 * public half (the JWK 'x' coordinate) - this script never sees, asks for,
 * or stores a private key (see apps/api/src/agent/identity/customer-token.ts's
 * own doc comment for why that's the whole point of choosing Ed25519).
 *
 * Refuses to run against what looks like the shared test database unless
 * --allow-test-db is passed, same as create-api-key/db-ensure-indexes.
 */
import mongoose from 'mongoose';
import { TENANT_ID_PATTERN } from '@supportpilot/shared';
import { assertNotTestDatabase } from '../db/database-name';
import { CustomerPublicKeyDocument, CustomerPublicKeySchema } from '../db/schemas/customer-public-key.schema';
import { MongooseCustomerPublicKeyRepository, ActiveKeyLimitExceededError, DuplicateKidError } from '../db/customer-public-key.repository';

const DEFAULT_MAX_ACTIVE_KEYS = 5;

function parseArgs(argv: string[]): Record<string, string | boolean> {
  const args: Record<string, string | boolean> = {};
  for (const arg of argv) {
    if (!arg.startsWith('--')) continue;
    const [key, value] = arg.slice(2).split('=');
    args[key] = value ?? true;
  }
  return args;
}

function requireTenantId(args: Record<string, string | boolean>): string {
  const tenantId = args.tenantId;
  if (typeof tenantId !== 'string' || !TENANT_ID_PATTERN.test(tenantId)) {
    throw new Error('--tenantId is required and must match the shared tenant id pattern.');
  }
  return tenantId;
}

async function runRegister(args: Record<string, string | boolean>): Promise<void> {
  const tenantId = requireTenantId(args);
  const kid = Number(args.kid);
  if (!Number.isInteger(kid) || kid < 0) {
    throw new Error('--kid is required and must be a non-negative integer.');
  }
  const publicKeyX = args.publicKeyX;
  if (typeof publicKeyX !== 'string' || publicKeyX.length === 0) {
    throw new Error('--publicKeyX is required (the Ed25519 JWK "x" coordinate, base64url).');
  }
  const maxActiveKeys = args.maxActiveKeys !== undefined ? Number(args.maxActiveKeys) : DEFAULT_MAX_ACTIVE_KEYS;

  const Model = mongoose.model<CustomerPublicKeyDocument>('CustomerPublicKey', CustomerPublicKeySchema);
  const repository = new MongooseCustomerPublicKeyRepository(Model);

  try {
    const record = await repository.register(tenantId, kid, publicKeyX, maxActiveKeys);
    console.log('Customer public key registered:');
    console.log(`Tenant: ${record.tenantId}`);
    console.log(`kid: ${record.kid}`);
    console.log(`Status: ${record.status}`);
  } catch (err) {
    if (err instanceof DuplicateKidError || err instanceof ActiveKeyLimitExceededError) {
      throw new Error(err.message);
    }
    throw err;
  }
}

async function runRetire(args: Record<string, string | boolean>): Promise<void> {
  const tenantId = requireTenantId(args);
  const kid = Number(args.retire);
  if (!Number.isInteger(kid) || kid < 0) {
    throw new Error('--retire must be a non-negative integer kid.');
  }

  const Model = mongoose.model<CustomerPublicKeyDocument>('CustomerPublicKey', CustomerPublicKeySchema);
  const repository = new MongooseCustomerPublicKeyRepository(Model);

  const retired = await repository.retire(tenantId, kid);
  if (!retired) {
    throw new Error(`No active key with kid ${kid} found for tenant "${tenantId}".`);
  }
  console.log(`Key kid=${kid} retired for tenant "${tenantId}". A token signed under this kid will now fail verification (UNKNOWN_KID).`);
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
    if (args.retire !== undefined) {
      await runRetire(args);
    } else {
      await runRegister(args);
    }
  } finally {
    await mongoose.disconnect();
  }
}

main().catch((err: unknown) => {
  console.error('register-customer-key failed:', err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
