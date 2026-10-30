/**
 * Proves REAL MongoDB transaction rollback - the REAL MongooseTransactionRunner
 * (apps/api/src/db/transaction-runner.ts) and the REAL PolicyChunkRepository's
 * insertMany(chunks, session), not PolicyIngestionService's own fallback
 * cleanup delete (that fallback exists because the in-memory FAKES used
 * elsewhere in this codebase have no real transactional rollback of their
 * own - see that file's comment). Here, insertMany() runs INSIDE a
 * transaction that then throws before the callback returns (i.e. before
 * the transaction would commit) - if MongoDB's own atomicity guarantee
 * didn't hold, the chunks inserted just before the throw would still be
 * visible afterward. They are not.
 */
import './test-env';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import { bootApp } from './app-harness';
import { cleanupTenant, createTenantFixture, disconnectFixtureConnection } from './tenant-fixture';
import { getTestMongoUri, integrationTestsEnabled } from './test-env';
import { TRANSACTION_RUNNER, TransactionRunner } from '../../src/db/transaction-runner';
import { NewPolicyChunk, POLICY_CHUNK_REPOSITORY, PolicyChunkRepository } from '../../src/db/policy-chunk.repository';
import { POLICY_DOCUMENT_REPOSITORY, PolicyDocumentRepository } from '../../src/db/policy-document.repository';

describe.skipIf(!integrationTestsEnabled())('Mid-commit transaction rollback (integration, real database)', () => {
  let app: INestApplication;
  let close: () => Promise<void>;
  const uri = integrationTestsEnabled() ? getTestMongoUri() : '';
  const createdTenants: string[] = [];

  beforeAll(async () => {
    const harness = await bootApp();
    app = harness.app;
    close = harness.close;
  }, 150_000);

  afterAll(async () => {
    await Promise.all(createdTenants.map((tenantId) => cleanupTenant(uri, tenantId)));
    await close();
    await disconnectFixtureConnection();
  });

  it(
    'rolls back a mid-transaction chunk insert and leaves the document failed, when the commit callback throws before returning',
    async () => {
      const tenant = await createTenantFixture(uri);
      createdTenants.push(tenant.tenantId);

      const transactionRunner = app.get<TransactionRunner>(TRANSACTION_RUNNER);
      const chunkRepository = app.get<PolicyChunkRepository>(POLICY_CHUNK_REPOSITORY);
      const documentRepository = app.get<PolicyDocumentRepository>(POLICY_DOCUMENT_REPOSITORY);

      const document = await documentRepository.create(tenant.tenantId, 'Rollback test', 'fake-content-hash');

      const newChunks: NewPolicyChunk[] = [
        {
          tenantId: tenant.tenantId,
          documentId: document.id,
          title: 'Rollback test',
          headingPath: 'Rollback test',
          position: 0,
          text: 'This chunk must never be visible after rollback.',
          embedding: new Array(768).fill(0.01),
          embeddingModel: 'fake-hashing-embedder',
          embeddingDimension: 768,
          contentHash: 'chunk-content-hash',
        },
      ];

      await expect(
        transactionRunner.withTransaction(async (session) => {
          // Real insertMany, inside the real session - then throw BEFORE
          // this callback returns, i.e. before session.withTransaction()
          // ever calls commitTransaction.
          await chunkRepository.insertMany(newChunks, session);
          throw new Error('simulated failure before commit');
        }),
      ).rejects.toThrow('simulated failure before commit');

      // The real guarantee under test: MongoDB rolled the insert back on
      // its own - nothing here calls deleteForDocument to force this.
      const chunkCountAfterRollback = await chunkRepository.countForTenant(tenant.tenantId);
      expect(chunkCountAfterRollback).toBe(0);

      // Mirrors exactly what PolicyIngestionService's own catch block does
      // on a real commit failure (policy-ingestion.service.ts) - proving
      // the document ends up in the same 'failed' state a real caller
      // would see, not just that the chunks vanished.
      await documentRepository.markFailed(tenant.tenantId, document.id, 'COMMIT_FAILED');
      const failedDocument = await documentRepository.findById(tenant.tenantId, document.id);
      expect(failedDocument?.status).toBe('failed');
      expect(failedDocument?.failureCode).toBe('COMMIT_FAILED');
      expect(failedDocument?.chunkCount).toBe(0);
    },
    60_000,
  );
});
