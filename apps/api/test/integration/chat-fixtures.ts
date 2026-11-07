/**
 * Shared Stage 6 plumbing for the /v1/chat integration suite: an in-process
 * mock-store instance, a temp connector-fixtures directory with baseUrl
 * rewritten to that instance's ephemeral port (the COMMITTED fixtures
 * under src/connectors/fixtures/acme are never touched), a scriptable
 * LlmProvider so each test can set its own deterministic plan/compose
 * script without rebooting the whole app, and an Ed25519 customer-token
 * minting helper.
 */
import { randomBytes, generateKeyPairSync, KeyObject } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import { createApp } from '@supportpilot/mock-store';
import { EmbedOutcome, EmbeddingTaskType, GenerateOptions, GenerateOutcome, LlmProvider } from '../../src/llm/llm-provider.interface';
import { FakeLlmProvider } from '../../src/llm/test-utils/fake-llm-provider';
import { signCustomerToken } from '../../src/agent/identity/customer-token';
import { createCustomerPublicKeyFixture } from './tenant-fixture';

export const MOCK_STORE_TOKEN = 'integration-test-mock-store-token';
export const CONNECTOR_SECRET_ENV_VAR = 'CONNECTOR_SECRET_ACME_MOCK_STORE_TOKEN';

export interface MockStoreHandle {
  baseUrl: string;
  close(): Promise<void>;
}

/** Fresh in-memory mock-store state (createApp's own guarantee), listening on an OS-assigned ephemeral port on loopback only. */
export async function startMockStore(): Promise<MockStoreHandle> {
  const app = createApp({ token: MOCK_STORE_TOKEN });
  const server: Server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

const ACME_CONNECTOR_TOOLS = ['get_order', 'track_shipment', 'issue_refund', 'escalate_to_human'] as const;

/**
 * Loads the four COMMITTED acme fixture files (never modified), rewrites
 * only `request.baseUrl`, and re-writes `tenantId` to match whatever
 * randomly-generated tenant id this test is actually using (the
 * committed files all say "acme" - FileConnectorConfigRepository's own
 * TenantMismatchError check requires the file's tenantId field to match
 * the directory it's loaded from), into
 * `<tempConnectorRoot>/<tenantId>/<tool>.json`. Safe to call multiple
 * times for different tenantIds against the SAME tempConnectorRoot -
 * FileConnectorConfigRepository reads the filesystem live on every call
 * (confirmed directly, not assumed - see connector-config.repository.ts),
 * so fixtures written after the app has already booted are picked up on
 * the very next request.
 */
const COMMITTED_ACME_FIXTURES_DIR = join(__dirname, '..', '..', 'src', 'connectors', 'fixtures', 'acme');

export async function writeAcmeConnectorFixtures(tempConnectorRoot: string, tenantId: string, mockStoreBaseUrl: string): Promise<void> {
  const tenantDir = join(tempConnectorRoot, tenantId);
  await mkdir(tenantDir, { recursive: true });

  for (const tool of ACME_CONNECTOR_TOOLS) {
    // Read as plain JSON data (matching FileConnectorConfigRepository's
    // own readFileSync + JSON.parse), never a module import - the
    // committed file is never touched, only this in-memory copy is
    // rewritten before being written to the temp directory.
    const raw = await readFile(join(COMMITTED_ACME_FIXTURES_DIR, `${tool}.json`), 'utf8');
    const committed = JSON.parse(raw) as Record<string, unknown>;
    const rewritten = {
      ...committed,
      tenantId,
      request: { ...(committed.request as Record<string, unknown>), baseUrl: mockStoreBaseUrl },
    };
    await writeFile(join(tenantDir, `${tool}.json`), JSON.stringify(rewritten, null, 2), 'utf8');
  }
}

export async function makeTempConnectorRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'supportpilot-chat-it-'));
}

export async function removeTempConnectorRoot(path: string): Promise<void> {
  await rm(path, { recursive: true, force: true });
}

/**
 * Wraps a swappable FakeLlmProvider so a test can set its OWN scripted
 * plan/compose queue (`setScript`) without rebooting the whole Nest
 * app/Mongo connection - rebuilding the TestingModule per scenario would
 * be far too slow against a real, network-hosted test database for a
 * suite this size. Each call to setScript() replaces the inner provider
 * entirely, so leftover unused script entries from a PREVIOUS test can
 * never bleed into the next one.
 */
export class ScriptableLlmProvider implements LlmProvider {
  private inner: LlmProvider = new FakeLlmProvider([]);

  setScript(responses: GenerateOutcome[]): void {
    this.inner = new FakeLlmProvider(responses);
  }

  /** Swaps in an arbitrary LlmProvider implementation (e.g. a gated or always-failing one) instead of a plain script - used by the concurrency and circuit-breaker scenarios. */
  setProvider(provider: LlmProvider): void {
    this.inner = provider;
  }

  embed(texts: string[], taskType: EmbeddingTaskType): Promise<EmbedOutcome> {
    return this.inner.embed(texts, taskType);
  }

  generate(options: GenerateOptions): Promise<GenerateOutcome> {
    return this.inner.generate(options);
  }

  /** How many generate() calls the CURRENT inner provider has seen since the last setScript/setProvider - used to assert "no LLM call was made" (e.g. an invalid-token request must be rejected before any generate() call). Only meaningful for a plain FakeLlmProvider inner (the default, and what setScript installs); 0 for any other provider swapped in via setProvider that doesn't track calls. */
  get generateCalls(): number {
    return this.inner instanceof FakeLlmProvider ? this.inner.generateCalls : 0;
  }
}

export interface CustomerKeyFixture {
  kid: number;
  privateKey: KeyObject;
  /** The JWK 'x' coordinate that was registered - exposed so a test can register this SAME public key under a SECOND tenant (same kid) to exercise verifyCustomerToken's TENANT_MISMATCH branch specifically (a signature that verifies, but whose payload.tenantId disagrees with the request's own authenticated tenant). */
  publicKeyX: string;
}

let nextKid = 1;

/** Generates a fresh Ed25519 keypair, registers the public half for tenantId via the real fixture helper, and returns the kid + private key this test needs to sign its own tokens with. Each call uses a fresh kid (module-scoped counter) so re-registering across tests in the same file never collides with CustomerPublicKey's own unique {tenantId,kid} index. */
export async function registerCustomerKeyFixture(uri: string, tenantId: string): Promise<CustomerKeyFixture> {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const jwk = publicKey.export({ format: 'jwk' }) as { x: string };
  const kid = nextKid++;
  await createCustomerPublicKeyFixture(uri, tenantId, kid, jwk.x);
  return { kid, privateKey, publicKeyX: jwk.x };
}

export function mintCustomerToken(tenantId: string, customerRef: string, kid: number, privateKey: KeyObject, expiresInMs = 10 * 60 * 1000): string {
  return signCustomerToken({ tenantId, customerRef, expiresAt: Date.now() + expiresInMs, kid }, privateKey);
}

/** A short, random, grep-able string for the canary-log test - never a fixed literal, so a leftover from a previous run can never produce a false pass. */
export function canaryString(): string {
  return `canary-${randomBytes(8).toString('hex')}`;
}
