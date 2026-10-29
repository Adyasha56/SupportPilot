/**
 * Seeds and tears down a scratch tenant + API key(s) directly via Mongoose,
 * the same way the create-api-key script does (see
 * src/scripts/create-api-key.ts) - this harness is test-only plumbing, not
 * something the app itself exposes over HTTP (there's no self-serve
 * tenant-signup endpoint, by design - see PROJECT.md's non-goals).
 *
 * Uses the DEFAULT global Mongoose connection (mongoose.connect/model), the
 * same one db-ensure-indexes.ts and create-api-key.ts use - this is a
 * SEPARATE connection object from the one Nest's DatabaseModule creates via
 * MongooseModule.forRoot (which uses mongoose.createConnection
 * internally), so there is no shared state or model-registration conflict
 * between this fixture helper and the app under test.
 */
import { randomUUID } from 'node:crypto';
import mongoose from 'mongoose';
import { generateRawApiKey, getKeyPrefix, hashApiKey } from '../../src/auth/api-key.service';
import { ApiKeySchema, ApiKeyScope } from '../../src/db/schemas/api-key.schema';
import { TenantSchema } from '../../src/db/schemas/tenant.schema';
import { PolicyChunkSchema } from '../../src/db/schemas/policy-chunk.schema';
import { PolicyDocumentSchema } from '../../src/db/schemas/policy-document.schema';
import { DEMO_TENANT_SETTINGS } from '../../src/db/tenant.repository';

export interface TenantFixture {
  tenantId: string;
  secretKey: string;
  publicKey: string;
}

export interface CreatedApiKey {
  id: string;
  rawKey: string;
}

let connected = false;

async function ensureConnected(uri: string): Promise<void> {
  if (connected) {
    return;
  }
  await mongoose.connect(uri);
  connected = true;
}

/** A fresh, random tenant id per test - so tests never collide and can run concurrently. */
export function randomTenantId(): string {
  return `it-${randomUUID().replace(/-/g, '').slice(0, 20)}`;
}

export async function createTenantFixture(uri: string, tenantId = randomTenantId()): Promise<TenantFixture> {
  await ensureConnected(uri);

  const TenantModel = mongoose.model('Tenant', TenantSchema);
  const ApiKeyModel = mongoose.model('ApiKey', ApiKeySchema);

  await TenantModel.create({ _id: tenantId, name: tenantId, settings: DEMO_TENANT_SETTINGS });

  const createKey = async (scope: ApiKeyScope): Promise<string> => {
    const rawKey = generateRawApiKey();
    await ApiKeyModel.create({
      tenantId,
      hash: hashApiKey(rawKey),
      keyPrefix: getKeyPrefix(rawKey),
      scopes: [scope],
      revokedAt: null,
    });
    return rawKey;
  };

  const secretKey = await createKey('secret');
  const publicKey = await createKey('public');

  return { tenantId, secretKey, publicKey };
}

/**
 * Creates one additional key for a tenant and returns its id alongside the
 * raw value, so a test can revoke it afterward via the real
 * ApiKeyRepository.revoke(id) - not exposed by createTenantFixture() itself
 * since most tests never need the id, only the raw key to send as a header.
 */
export async function createApiKeyFixture(uri: string, tenantId: string, scope: ApiKeyScope = 'secret'): Promise<CreatedApiKey> {
  await ensureConnected(uri);

  const ApiKeyModel = mongoose.model('ApiKey', ApiKeySchema);
  const rawKey = generateRawApiKey();
  const doc = await ApiKeyModel.create({
    tenantId,
    hash: hashApiKey(rawKey),
    keyPrefix: getKeyPrefix(rawKey),
    scopes: [scope],
    revokedAt: null,
  });

  return { id: doc._id.toString(), rawKey };
}

/**
 * Cleanup by tenantId only, across every collection a test could have
 * written to - NEVER dropDatabase (the test database is shared across the
 * whole suite and, when run against a developer's own Atlas cluster per
 * Stage 7 item 5, against the index/collection state db:ensure-indexes
 * just set up). Safe to call even if some collections have nothing for
 * this tenant. Callers should run this in a `finally`/`afterEach`, not just
 * on the happy path, so a failing assertion still cleans up.
 */
export async function cleanupTenant(uri: string, tenantId: string): Promise<void> {
  await ensureConnected(uri);

  const TenantModel = mongoose.model('Tenant', TenantSchema);
  const ApiKeyModel = mongoose.model('ApiKey', ApiKeySchema);
  const PolicyChunkModel = mongoose.model('PolicyChunk', PolicyChunkSchema);
  const PolicyDocumentModel = mongoose.model('PolicyDocument', PolicyDocumentSchema);

  await Promise.all([
    TenantModel.deleteOne({ _id: tenantId }),
    ApiKeyModel.deleteMany({ tenantId }),
    PolicyChunkModel.deleteMany({ tenantId }),
    PolicyDocumentModel.deleteMany({ tenantId }),
  ]);
}

export async function disconnectFixtureConnection(): Promise<void> {
  if (connected) {
    await mongoose.disconnect();
    connected = false;
  }
}
