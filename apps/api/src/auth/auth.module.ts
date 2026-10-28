import { Module } from '@nestjs/common';
import { DatabaseModule } from '../db/database.module';
import { ApiKeyGuard } from './api-key.guard';

@Module({
  imports: [DatabaseModule],
  providers: [ApiKeyGuard],
  exports: [ApiKeyGuard],
})
export class AuthModule {}
