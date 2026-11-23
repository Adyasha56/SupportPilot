import { Module } from '@nestjs/common';
import { AdminAuthModule } from '../admin-auth/admin-auth.module';
import { DatabaseModule } from '../db/database.module';
import { ConnectorsModule } from './connectors.module';
import { ConnectorsAdminController } from './connectors-admin.controller';

/**
 * Root cause, found via real diagnostic logging against a real CI run
 * (2026-11-23): `AdminAuthGuard` is resolved via `@UseGuards(AdminAuthGuard)`
 * through the CONSUMING controller's own module injector context, not
 * strictly reused as one global singleton. `AdminAuthModule` exports the
 * guard CLASS itself, but its `API_KEY_REPOSITORY`/`ADMIN_SESSION_REPOSITORY`
 * constructor dependencies (both `@Optional()`, provided by `DatabaseModule`,
 * which `AdminAuthModule` imports but does not itself re-export) only
 * resolve correctly when `DatabaseModule` is ALSO directly visible in the
 * SAME module that declares the guarded controller - not merely reachable
 * one level further through `AdminAuthModule`. A real diagnostic log
 * confirmed this directly: the guard instance protecting
 * `ConnectorsAdminController` had BOTH repositories `undefined`
 * (`hasApiKeyRepository: false, hasSessionRepository: false`), while the
 * identical guard protecting every other admin controller showed `true` for
 * both - because `IngestionModule`/`ApprovalsModule`/`ConversationsAdminModule`/
 * `TenantSettingsAdminModule` ALL independently import `DatabaseModule`
 * themselves too, for their own repositories - this module was the only
 * one that didn't. Importing it here, even though
 * `ConnectorsAdminController` itself needs no repository from it, is the
 * actual fix - confirmed necessary, not a guess. See
 * docs/known-limitations.md for the fuller account.
 */
export function connectorsAdminDatabaseImportsFor(env: NodeJS.ProcessEnv): [typeof DatabaseModule] | [] {
  return env.MONGODB_URI ? [DatabaseModule] : [];
}

@Module({
  imports: [AdminAuthModule, ConnectorsModule, ...connectorsAdminDatabaseImportsFor(process.env)],
  controllers: [ConnectorsAdminController],
})
export class ConnectorsAdminModule {}
