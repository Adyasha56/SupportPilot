import { Module } from '@nestjs/common';
import { DatabaseModule } from '../db/database.module';
import { LlmModule } from '../llm/llm.module';
import { PolicyRetrievalService } from './policy-retrieval.service';
import { retrievalSettingsProvider } from './retrieval-settings.provider';

/**
 * Always imported into AppModule, regardless of whether MONGODB_URI is set
 * - same self-contained conditional pattern as AuthModule and
 * IngestionModule (see those modules' own doc comments, and
 * docs/learning-notes.md's Stage 5 entry on the bug this pattern fixes:
 * a module must import DatabaseModule itself to see its exported tokens,
 * not just share a parent with something that does).
 */
const retrievalDatabaseImports = process.env.MONGODB_URI ? [DatabaseModule] : [];

@Module({
  imports: [LlmModule, ...retrievalDatabaseImports],
  providers: [retrievalSettingsProvider, PolicyRetrievalService],
  exports: [PolicyRetrievalService],
})
export class RetrievalModule {}
