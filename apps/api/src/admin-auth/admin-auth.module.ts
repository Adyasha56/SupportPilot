import { Module } from '@nestjs/common';
import { DatabaseModule } from '../db/database.module';
import { AdminAuthGuard } from './admin-auth.guard';
import { ADMIN_AUTH_SETTINGS, adminAuthSettingsProvider } from './admin-auth-settings.provider';
import { adminLoginRateLimiterProvider } from './admin-login-rate-limiter.provider';
import { hashConcurrencyLimiterProvider } from './hash-concurrency-limiter.provider';
import { AdminLoginService } from './admin-login.service';
import { AdminSessionService } from './admin-session.service';
import { VerifyPasswordService } from './verify-password.service';
import { AdminLoginController } from './admin-login.controller';

/**
 * Same "always importable, even with no database, repository deps are
 * @Optional()" discipline as AuthModule/ChatModule - every /v1/admin/*
 * route exists and returns a real response (401/503, never a crash or a
 * silently-missing route) regardless of whether MONGODB_URI is set.
 */
export function adminAuthDatabaseImportsFor(env: NodeJS.ProcessEnv): [typeof DatabaseModule] | [] {
  return env.MONGODB_URI ? [DatabaseModule] : [];
}

@Module({
  imports: [...adminAuthDatabaseImportsFor(process.env)],
  controllers: [AdminLoginController],
  providers: [
    AdminAuthGuard,
    adminAuthSettingsProvider,
    adminLoginRateLimiterProvider,
    hashConcurrencyLimiterProvider,
    AdminLoginService,
    AdminSessionService,
    VerifyPasswordService,
  ],
  exports: [AdminAuthGuard, ADMIN_AUTH_SETTINGS, VerifyPasswordService],
})
export class AdminAuthModule {}
