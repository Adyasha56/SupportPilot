import { Injectable } from '@nestjs/common';
import mongoose, { ClientSession } from 'mongoose';

export interface TransactionRunner {
  withTransaction<T>(fn: (session: ClientSession) => Promise<T>): Promise<T>;
}

export const TRANSACTION_RUNNER = Symbol('TRANSACTION_RUNNER');

/**
 * session.withTransaction() (not manual startTransaction/commitTransaction)
 * is the officially recommended pattern specifically because it retries
 * the whole callback automatically on a TransientTransactionError and
 * retries just the commit on an UnknownTransactionCommitResult - confirmed
 * working empirically against the project's real Atlas M0 cluster via
 * apps/api/src/scripts/check-transactions.ts (see docs/learning-notes.md).
 */
@Injectable()
export class MongooseTransactionRunner implements TransactionRunner {
  async withTransaction<T>(fn: (session: ClientSession) => Promise<T>): Promise<T> {
    const session = await mongoose.startSession();
    try {
      let result: T | undefined;
      await session.withTransaction(async () => {
        result = await fn(session);
      });
      return result as T;
    } finally {
      await session.endSession();
    }
  }
}
