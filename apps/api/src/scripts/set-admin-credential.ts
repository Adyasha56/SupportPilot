/**
 * Milestone 5, Stage 1b, item 1 - the ONLY way an AdminCredential is ever
 * created or replaced; no HTTP endpoint does this. Manually run only, same
 * reasoning as every other script in this directory (runs compiled JS -
 * see create-api-key.ts's own header for why).
 *
 *   pnpm run set-admin-credential -- --tenantId=acme --email=owner@acme.example
 *
 * The password is NEVER accepted on argv (it would leak into shell history
 * and the process list, visible to anyone else on the same machine via
 * `ps`) - set it via the `ADMIN_CREDENTIAL_PASSWORD` environment variable
 * for a non-interactive/scripted run, or simply omit it for an interactive
 * hidden-input prompt (no echo, no new dependency - `readHiddenPassword`
 * below is a small raw-mode TTY reader). `--password=...` is explicitly
 * detected and refused, not merely "not read".
 *
 * On a tenant that ALREADY has a credential, this REPLACES its
 * email/passwordHash (not an error) and revokes every existing session of
 * that credential (anti-fixation's other half: a password/email change
 * must never leave an old session silently still valid) - unconditionally,
 * since a tenant with no prior sessions simply has nothing to revoke.
 *
 * Refuses to run against what looks like the shared test database unless
 * --allow-test-db is passed, same as every other script here.
 */
import mongoose, { Model } from 'mongoose';
import { TENANT_ID_PATTERN } from '@supportpilot/shared';
import { assertNotTestDatabase } from '../db/database-name';
import { AdminCredentialDocument, AdminCredentialSchema } from '../db/schemas/admin-credential.schema';
import { AdminSessionDocument, AdminSessionSchema } from '../db/schemas/admin-session.schema';
import { MongooseAdminCredentialRepository } from '../db/admin-credential.repository';
import { MongooseAdminSessionRepository } from '../db/admin-session.repository';
import { hashPassword } from '../admin-auth/password-hash';

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

export function requireEmail(args: Record<string, string | boolean>): string {
  const email = args.email;
  if (typeof email !== 'string' || !email.includes('@') || email.trim().length === 0) {
    throw new Error('--email is required and must look like an email address.');
  }
  return email.trim().toLowerCase();
}

export const MINIMUM_PASSWORD_LENGTH = 12;

/** A SHORT denylist (item 1's own wording) - not an attempt at a real breached-password list, just the most obvious trivial choices that length alone wouldn't catch. */
export const TRIVIAL_PASSWORD_DENYLIST = [
  'password',
  'password1234',
  'passwordpassword',
  '123456789012',
  'qwertyuiopas',
  'letmein12345',
  'admin1234567',
  'changeme1234',
  'supportpilot',
];

export class WeakPasswordError extends Error {}

export function validatePasswordStrength(password: string): void {
  if (password.length < MINIMUM_PASSWORD_LENGTH) {
    throw new WeakPasswordError(`Password must be at least ${MINIMUM_PASSWORD_LENGTH} characters.`);
  }
  if (TRIVIAL_PASSWORD_DENYLIST.includes(password.toLowerCase())) {
    throw new WeakPasswordError('Password is on the denylist of trivial passwords - choose something less guessable.');
  }
}

/** Reads a password with NO echo, raw-mode TTY, no new dependency. Rejects if stdin isn't a real TTY (e.g. piped input in CI) - that case should use ADMIN_CREDENTIAL_PASSWORD instead, never a silently-echoed fallback. */
export function readHiddenPassword(promptText: string): Promise<string> {
  return new Promise((resolve, reject) => {
    if (!process.stdin.isTTY) {
      reject(new Error('No interactive TTY available for a hidden password prompt - set ADMIN_CREDENTIAL_PASSWORD instead.'));
      return;
    }
    process.stdout.write(promptText);
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding('utf8');

    let input = '';
    const onData = (char: string): void => {
      if (char === '\u0003') {
        cleanup();
        process.stdout.write('\n');
        reject(new Error('Aborted.'));
        return;
      }
      if (char === '\r' || char === '\n') {
        cleanup();
        process.stdout.write('\n');
        resolve(input);
        return;
      }
      if (char === '\u007f' || char === '\b') {
        input = input.slice(0, -1);
        return;
      }
      input += char;
    };
    const cleanup = (): void => {
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdin.removeListener('data', onData);
    };
    process.stdin.on('data', onData);
  });
}

export async function resolvePassword(args: Record<string, string | boolean>): Promise<string> {
  if (args.password !== undefined) {
    throw new Error('--password is never accepted on the command line (shell history/process list exposure). Set ADMIN_CREDENTIAL_PASSWORD, or omit it entirely for a hidden prompt.');
  }
  const envPassword = process.env.ADMIN_CREDENTIAL_PASSWORD;
  if (envPassword) {
    return envPassword;
  }
  return readHiddenPassword('Enter the new admin password (input hidden): ');
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
  const email = requireEmail(args);
  const password = await resolvePassword(args);
  validatePasswordStrength(password);

  assertNotTestDatabase(uri, args['allow-test-db'] === true);

  await mongoose.connect(uri);
  try {
    const CredentialModel: Model<AdminCredentialDocument> = mongoose.model<AdminCredentialDocument>('AdminCredential', AdminCredentialSchema);
    const SessionModel: Model<AdminSessionDocument> = mongoose.model<AdminSessionDocument>('AdminSession', AdminSessionSchema);
    const credentialRepository = new MongooseAdminCredentialRepository(CredentialModel);
    const sessionRepository = new MongooseAdminSessionRepository(SessionModel);

    const existing = await credentialRepository.findByTenantId(tenantId);
    const passwordHash = await hashPassword(password);
    await credentialRepository.upsert(tenantId, email, passwordHash);
    // Anti-fixation's other half - a password/email change must never leave a prior session
    // valid. Unconditional: a brand-new tenant simply has nothing to revoke.
    await sessionRepository.deleteAllForPrincipal(tenantId, tenantId);

    console.log(`Admin credential for tenant "${tenantId}" (${email}) ${existing ? 'replaced' : 'created'}.`);
    if (existing) {
      console.log('Every existing admin console session for this tenant has been revoked.');
    }
  } finally {
    await mongoose.disconnect();
  }
}

main().catch((err: unknown) => {
  console.error('set-admin-credential failed:', err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
