/**
 * Manually run only, same reasoning as every other script in this
 * directory (runs compiled JS - see create-api-key.ts, src/scripts/).
 *
 *   pnpm run mint-customer-token -- --tenantId=acme --customerRef=cust_1
 *   pnpm run mint-customer-token -- --tenantId=acme --customerRef=cust_1 --kid=2 --lifetimeMs=120000
 *
 * Lives under dev-scripts/, NOT src/scripts/ - a real misplacement in an
 * earlier version of this file, corrected directly: this one GENERATES
 * and HOLDS Ed25519 PRIVATE KEY material locally, which is categorically
 * different from every script that stays in src/scripts/ (create-api-key
 * hashes a key it generates but never stores the raw value; register-
 * customer-key only ever registers a public key someone else already
 * generated - neither one ever persists private key material to disk).
 * "dev-scripts never touches the real repository layer" was never
 * actually the dividing line either - retrieval-quality-check.ts and
 * agent-pipeline-smoke-test.ts, right here in this same directory, both
 * already import and use the real MongoosePolicyChunkRepository/
 * MongoosePolicyDocumentRepository/MongooseTransactionRunner directly.
 * The real dividing line is build output: src/scripts/*.ts compiles into
 * the PRODUCTION image via `nest build`'s own tsconfig.build.json
 * (src/**\/*.ts only); dev-scripts/*.ts compiles separately, into
 * dist-dev/, via `pnpm run build:dev-scripts` (tsconfig.dev-scripts.json)
 * - excluded from the production build and the Docker image entirely. A
 * tool that mints private keys has no business being reachable from a
 * deployed container even in principle, which is exactly what this move
 * guarantees (confirmed by the scratch deploy simulation - see
 * docs/learning-notes.md).
 *
 * What this does, in order:
 *  1. Generates a FRESH Ed25519 keypair (a throwaway testing identity, one
 *     per tenantId+kid) unless a key file for this exact (tenantId, kid)
 *     already exists locally, in which case it's reused - so re-running
 *     this script for the same tenant/kid to mint ANOTHER token (e.g. a
 *     shorter-lived one) never collides with the key already registered
 *     in the database under that kid.
 *  2. Writes ONLY the private key material to a gitignored local file
 *     (KEY_DIR, default ./.customer-keys/ - see .gitignore) - never
 *     printed to stdout, never logged, at any point.
 *  3. If MONGODB_URI is set, registers the public half directly through
 *     MongooseCustomerPublicKeyRepository (the exact class
 *     register-customer-key.ts uses) - a DuplicateKidError here means
 *     it's already registered (e.g. a prior run), which is treated as
 *     success, not a failure, since the end state either way is "this key
 *     is registered." If MONGODB_URI is unset, registration is skipped
 *     entirely and the exact register-customer-key command is printed
 *     instead, for the operator to run themselves against whichever
 *     database they intend.
 *  4. Signs and prints a token for the given tenantId/customerRef/kid -
 *     the ONLY secret-shaped thing this script ever writes to stdout (a
 *     short-lived token, not a private key), with an explicit warning not
 *     to log or commit it.
 *
 * Refuses to register against what looks like the shared test database
 * unless --allow-test-db is passed, same as every other script here.
 */
import { createPrivateKey, generateKeyPairSync, JsonWebKey, KeyObject } from 'node:crypto';
import { mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import mongoose from 'mongoose';
import { GENERIC_ID_PATTERN, TENANT_ID_PATTERN } from '@supportpilot/shared';
import { assertNotTestDatabase } from '../src/db/database-name';
import { CUSTOMER_TOKEN_MAX_LIFETIME_MS, signCustomerToken } from '../src/agent/identity/customer-token';
import { CustomerPublicKeyDocument, CustomerPublicKeySchema } from '../src/db/schemas/customer-public-key.schema';
import { MongooseCustomerPublicKeyRepository, DuplicateKidError } from '../src/db/customer-public-key.repository';

const DEFAULT_KEY_DIR = './.customer-keys';
const DEFAULT_KID = 1;
const DEFAULT_LIFETIME_MS = 5 * 60 * 1000;
const DEFAULT_MAX_ACTIVE_KEYS = 5;

export function parseArgs(argv: string[]): Record<string, string | boolean> {
  const args: Record<string, string | boolean> = {};
  for (const arg of argv) {
    if (!arg.startsWith('--')) continue;
    const [key, value] = arg.slice(2).split('=');
    args[key] = value ?? true;
  }
  return args;
}

export function requireTenantId(args: Record<string, string | boolean>): string {
  const tenantId = args.tenantId;
  if (typeof tenantId !== 'string' || !TENANT_ID_PATTERN.test(tenantId)) {
    throw new Error('--tenantId is required and must match the shared tenant id pattern.');
  }
  return tenantId;
}

export function requireCustomerRef(args: Record<string, string | boolean>): string {
  const customerRef = args.customerRef;
  if (typeof customerRef !== 'string' || !GENERIC_ID_PATTERN.test(customerRef)) {
    throw new Error('--customerRef is required and must match the shared id pattern.');
  }
  return customerRef;
}

export function resolveKid(args: Record<string, string | boolean>): number {
  if (args.kid === undefined) {
    return DEFAULT_KID;
  }
  const kid = Number(args.kid);
  if (!Number.isInteger(kid) || kid < 0) {
    throw new Error('--kid must be a non-negative integer.');
  }
  return kid;
}

/**
 * Warns (never throws) when the requested lifetime exceeds
 * CUSTOMER_TOKEN_MAX_LIFETIME_MS - the server's own verifyCustomerToken
 * would reject such a token outright (EXPIRY_TOO_FAR), so minting one
 * anyway would just hand the operator a token guaranteed to fail; the
 * warning exists so that failure is explained BEFORE it happens, not
 * after a confusing 401 later.
 */
export function resolveLifetimeMs(args: Record<string, string | boolean>, warn: (message: string) => void): number {
  const lifetimeMs = args.lifetimeMs === undefined ? DEFAULT_LIFETIME_MS : Number(args.lifetimeMs);
  if (!Number.isFinite(lifetimeMs) || lifetimeMs <= 0) {
    throw new Error('--lifetimeMs must be a positive number of milliseconds.');
  }
  if (lifetimeMs > CUSTOMER_TOKEN_MAX_LIFETIME_MS) {
    warn(
      `--lifetimeMs (${lifetimeMs}) exceeds CUSTOMER_TOKEN_MAX_LIFETIME_MS (${CUSTOMER_TOKEN_MAX_LIFETIME_MS}) - the server will reject this token as EXPIRY_TOO_FAR.`,
    );
  }
  return lifetimeMs;
}

export function resolveKeyDir(dir: string): string {
  if (dir.trim().length === 0) {
    throw new Error('MINT_CUSTOMER_TOKEN_KEY_DIR must not be empty.');
  }
  return resolve(dir);
}

/** A safe, fixed-shape filename from already-validated tenantId/kid - never built from unvalidated input. */
export function keyFilePathFor(dir: string, tenantId: string, kid: number): string {
  return join(resolveKeyDir(dir), `${tenantId}.${kid}.json`);
}

/** The exact command an operator would run to register this key by hand - printed when MONGODB_URI isn't set, so this script is still useful with zero database access. */
export function buildRegisterCommand(tenantId: string, kid: number, publicKeyX: string): string {
  return `pnpm run register-customer-key -- --tenantId=${tenantId} --kid=${kid} --publicKeyX=${publicKeyX}`;
}

interface StoredKeyFile {
  tenantId: string;
  kid: number;
  privateKeyJwk: JsonWebKey;
}

function loadOrCreateKeyFile(dir: string, tenantId: string, kid: number): { privateKey: KeyObject; publicKeyX: string; reused: boolean } {
  const keyDir = resolveKeyDir(dir);
  mkdirSync(keyDir, { recursive: true });
  const filePath = keyFilePathFor(dir, tenantId, kid);

  if (existsSync(filePath)) {
    const stored = JSON.parse(readFileSync(filePath, 'utf8')) as StoredKeyFile;
    const privateKey = createPrivateKey({ key: stored.privateKeyJwk, format: 'jwk' });
    const publicKeyX = stored.privateKeyJwk.x;
    if (typeof publicKeyX !== 'string') {
      throw new Error(`Stored key file "${filePath}" is missing its "x" coordinate.`);
    }
    return { privateKey, publicKeyX, reused: true };
  }

  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const privateKeyJwk = privateKey.export({ format: 'jwk' });
  const publicKeyX = publicKey.export({ format: 'jwk' }).x;
  if (typeof publicKeyX !== 'string') {
    throw new Error('Generated Ed25519 keypair did not export an "x" coordinate.');
  }
  const toStore: StoredKeyFile = { tenantId, kid, privateKeyJwk };
  writeFileSync(filePath, JSON.stringify(toStore), { mode: 0o600 });
  return { privateKey, publicKeyX, reused: false };
}

async function registerIfPossible(tenantId: string, kid: number, publicKeyX: string): Promise<void> {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    console.log('MONGODB_URI is not set - skipping registration. Run this yourself against the right database:');
    console.log(`  ${buildRegisterCommand(tenantId, kid, publicKeyX)}`);
    return;
  }

  const args = parseArgs(process.argv.slice(2));
  assertNotTestDatabase(uri, args['allow-test-db'] === true);

  await mongoose.connect(uri);
  try {
    const Model = mongoose.model<CustomerPublicKeyDocument>('CustomerPublicKey', CustomerPublicKeySchema);
    const repository = new MongooseCustomerPublicKeyRepository(Model);
    try {
      await repository.register(tenantId, kid, publicKeyX, DEFAULT_MAX_ACTIVE_KEYS);
      console.log(`Registered public key for tenant "${tenantId}", kid=${kid}.`);
    } catch (err) {
      if (err instanceof DuplicateKidError) {
        console.log(`kid=${kid} is already registered for tenant "${tenantId}" - reusing it.`);
        return;
      }
      throw err;
    }
  } finally {
    await mongoose.disconnect();
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const tenantId = requireTenantId(args);
  const customerRef = requireCustomerRef(args);
  const kid = resolveKid(args);
  const lifetimeMs = resolveLifetimeMs(args, (message) => console.warn(`Warning: ${message}`));
  const keyDir = resolveKeyDir(typeof args.keyDir === 'string' ? args.keyDir : (process.env.MINT_CUSTOMER_TOKEN_KEY_DIR ?? DEFAULT_KEY_DIR));

  const { privateKey, publicKeyX, reused } = loadOrCreateKeyFile(keyDir, tenantId, kid);
  console.log(`${reused ? 'Reusing' : 'Generated'} a local key for tenant "${tenantId}", kid=${kid} (private key never printed - see ${keyFilePathFor(keyDir, tenantId, kid)}).`);

  if (!reused) {
    await registerIfPossible(tenantId, kid, publicKeyX);
  } else {
    console.log('Skipping registration - this key file already existed, so it should already be registered.');
  }

  const token = signCustomerToken({ tenantId, customerRef, expiresAt: Date.now() + lifetimeMs, kid }, privateKey);

  console.log('');
  console.log('--- Signed customer token (treat as a secret - do not log or commit this) ---');
  console.log(token);
  console.log('--- expires in', Math.round(lifetimeMs / 1000), 'seconds ---');
}

main().catch((err: unknown) => {
  console.error('mint-customer-token failed:', err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
