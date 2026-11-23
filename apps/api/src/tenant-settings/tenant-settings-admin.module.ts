import { Module } from '@nestjs/common';
import { AdminAuthModule } from '../admin-auth/admin-auth.module';
import { DatabaseModule } from '../db/database.module';
import { TenantSettingsAdminController } from './tenant-settings-admin.controller';
import { TenantSettingsAdminService } from './tenant-settings-admin.service';

/**
 * Stage 1c, item 3. `AdminAuthModule` is imported for both `AdminAuthGuard`
 * and `VerifyPasswordService` (both already exported from there, Stage 1b
 * item 7) - this module wires no password-hashing machinery of its own.
 * Same always-importable-with-no-database pattern as every other domain
 * module here.
 */
export function tenantSettingsAdminDatabaseImportsFor(env: NodeJS.ProcessEnv): [typeof DatabaseModule] | [] {
  return env.MONGODB_URI ? [DatabaseModule] : [];
}

@Module({
  imports: [AdminAuthModule, ...tenantSettingsAdminDatabaseImportsFor(process.env)],
  controllers: [TenantSettingsAdminController],
  providers: [TenantSettingsAdminService],
})
export class TenantSettingsAdminModule {}
