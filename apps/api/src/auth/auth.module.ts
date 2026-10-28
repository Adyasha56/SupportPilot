import { Module } from '@nestjs/common';
import { DatabaseModule } from '../db/database.module';
import { ApiKeyGuard } from './api-key.guard';

/**
 * Always safely importable, with or without MONGODB_URI set - unlike
 * DatabaseModule itself, which crashes immediately if given no URI.
 * DatabaseModule is only imported here when a URI is present; ApiKeyGuard's
 * repository dependency is @Optional() for exactly this reason (see
 * api-key.guard.ts), so a guarded route still boots and responds (with a
 * 503, not a crash or an unauthenticated bypass) when there's no database.
 * This lets IngestionModule (Stage 5) import AuthModule unconditionally, so
 * /v1/policies routes exist and return a proper 503 instead of a bare 404
 * when the database isn't configured.
 */
const authImports = process.env.MONGODB_URI ? [DatabaseModule] : [];

@Module({
  imports: authImports,
  providers: [ApiKeyGuard],
  exports: [ApiKeyGuard],
})
export class AuthModule {}
