/**
 * Manually run only, same reasoning as every other script in this
 * directory (runs compiled JS, see create-api-key.ts's own header).
 *
 *   pnpm run set-tenant-settings -- --tenantId=acme --refundCap=2000 \
 *     --approvalThreshold=250 --refundWindowDays=30 --autoExecuteRefunds=false \
 *     --approvalExpiryDays=7 [--dailyRefundCountLimit=3]
 *
 * There is no admin console yet (Milestone 5) - this is the only way to
 * change a tenant's Milestone 4 refund-verifier settings today. Only the
 * flags actually passed are changed; an omitted flag keeps its current
 * stored value, it is never reset to a default. Refuses to run against
 * what looks like the shared test database unless --allow-test-db is
 * passed, same as every other script here. Errors clearly if the tenant
 * doesn't exist yet rather than silently creating one with partial
 * settings - run create-api-key first.
 */
import mongoose, { Model } from 'mongoose';
import { TENANT_ID_PATTERN } from '@supportpilot/shared';
import { assertNotTestDatabase } from '../db/database-name';
import { TenantDocument, TenantSchema } from '../db/schemas/tenant.schema';
import { MongooseTenantRepository, Tenant, TenantSettingsPatch } from '../db/tenant.repository';

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

function resolveNonNegativeNumber(args: Record<string, string | boolean>, flag: string): number | undefined {
  if (args[flag] === undefined) {
    return undefined;
  }
  const value = Number(args[flag]);
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`--${flag} must be a non-negative number.`);
  }
  return value;
}

function resolvePositiveInteger(args: Record<string, string | boolean>, flag: string): number | undefined {
  if (args[flag] === undefined) {
    return undefined;
  }
  const value = Number(args[flag]);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`--${flag} must be a positive integer.`);
  }
  return value;
}

function resolveBoolean(args: Record<string, string | boolean>, flag: string): boolean | undefined {
  const raw = args[flag];
  if (raw === undefined) {
    return undefined;
  }
  if (raw === 'true' || raw === true) {
    return true;
  }
  if (raw === 'false') {
    return false;
  }
  throw new Error(`--${flag} must be "true" or "false".`);
}

/** Exported for its own unit test - every flag is independently optional, and this never silently drops a validation error from one flag just because another flag was invalid first. */
export function buildSettingsPatch(args: Record<string, string | boolean>): TenantSettingsPatch {
  return {
    refundCap: resolveNonNegativeNumber(args, 'refundCap'),
    approvalThreshold: resolveNonNegativeNumber(args, 'approvalThreshold'),
    refundWindowDays: resolvePositiveInteger(args, 'refundWindowDays'),
    autoExecuteRefunds: resolveBoolean(args, 'autoExecuteRefunds'),
    approvalExpiryDays: resolvePositiveInteger(args, 'approvalExpiryDays'),
    dailyRefundCountLimit: resolvePositiveInteger(args, 'dailyRefundCountLimit'),
  };
}

function hasAnySetting(patch: TenantSettingsPatch): boolean {
  return Object.values(patch).some((value) => value !== undefined);
}

function printTenant(tenant: Tenant): void {
  console.log(`Tenant "${tenant.id}" settings are now:`);
  console.log(`  refundCap: ${tenant.refundCap ?? '(unset)'}`);
  console.log(`  approvalThreshold: ${tenant.approvalThreshold ?? '(unset)'}`);
  console.log(`  refundWindowDays: ${tenant.refundWindowDays ?? '(unset)'}`);
  console.log(`  autoExecuteRefunds: ${tenant.autoExecuteRefunds ?? '(unset)'}`);
  console.log(`  approvalExpiryDays: ${tenant.approvalExpiryDays ?? '(unset)'}`);
  console.log(`  dailyRefundCountLimit: ${tenant.dailyRefundCountLimit ?? '(unset)'}`);
}

async function main(): Promise<void> {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    console.error('MONGODB_URI is not set.');
    process.exitCode = 1;
    return;
  }

  const args = parseArgs(process.argv.slice(2));
  const tenantId = requireTenantId(args);
  const patch = buildSettingsPatch(args);
  if (!hasAnySetting(patch)) {
    throw new Error('No settings flags were passed - nothing to do. See this script\'s header for the available flags.');
  }

  assertNotTestDatabase(uri, args['allow-test-db'] === true);

  await mongoose.connect(uri);
  try {
    // Explicit <TenantDocument> type argument (not left to inference) - TenantSchema's string
    // _id (unlike every other schema's default ObjectId _id) makes mongoose.model()'s inferred
    // return type too specific to structurally satisfy MongooseTenantRepository's constructor
    // parameter (Model<TenantDocument> from @InjectModel) otherwise.
    const TenantModel: Model<TenantDocument> = mongoose.model<TenantDocument>('Tenant', TenantSchema);
    const repository = new MongooseTenantRepository(TenantModel);
    const tenant = await repository.updateSettings(tenantId, patch);
    printTenant(tenant);
  } finally {
    await mongoose.disconnect();
  }
}

main().catch((err: unknown) => {
  console.error('set-tenant-settings failed:', err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
