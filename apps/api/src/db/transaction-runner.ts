import { Injectable } from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import { ClientSession, Connection } from 'mongoose';

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
 *
 * The session MUST come from the same Connection the repositories' models
 * are registered on. @nestjs/mongoose's MongooseModule.forRoot() calls
 * mongoose.createConnection(uri, options) internally (confirmed by reading
 * its source) - an isolated Connection instance, NOT the bare default
 * mongoose.connection that a plain `import mongoose from 'mongoose';
 * mongoose.startSession()` operates on. Starting a session from the wrong
 * (disconnected) default connection doesn't error immediately - every
 * session-bound operation against the real models just buffers and times
 * out after Mongoose's default 10s bufferTimeoutMS, which is exactly what
 * happened here before this was fixed: confirmed directly against the
 * real server, "Connection operation buffering timed out after 10000ms".
 * @InjectConnection() gets the actual connection Nest wired up.
 */
@Injectable()
export class MongooseTransactionRunner implements TransactionRunner {
  constructor(@InjectConnection() private readonly connection: Connection) {}

  async withTransaction<T>(fn: (session: ClientSession) => Promise<T>): Promise<T> {
    const session = await this.connection.startSession();
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
