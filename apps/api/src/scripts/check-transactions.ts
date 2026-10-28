/**
 * Manually run only - a throwaway probe, not part of the app or any other
 * script. Answers one question empirically rather than assuming it:
 * does a multi-document, multi-operation transaction actually commit on
 * this specific Atlas cluster? Transactions need a replica set (not a
 * standalone mongod); Atlas M0 free clusters ARE a 3-node replica set, so
 * they should support transactions, but "should" is exactly the kind of
 * claim RULES.md says to verify rather than assume - free-tier behavior
 * and limits can differ from the general docs, and this is cheap to check
 * directly.
 *
 * Uses a scratch collection (`_transaction_probe`) in the SAME database
 * your MONGODB_URI points at, and drops that collection again when done,
 * success or failure - it leaves nothing behind. Still refuses to run
 * against a database name starting with "test_" unless --allow-test-db is
 * passed, same guard as every other script here.
 *
 * Run compiled JS, not the .ts source directly, same reasoning as every
 * other script (Node's native TypeScript stripping doesn't support
 * decorators/constructor parameter properties - this script doesn't use
 * either, but stays consistent with the others' execution mechanism).
 *
 *   pnpm run check-transactions
 */
import mongoose from 'mongoose';
import { assertNotTestDatabase, getDatabaseNameFromUri } from '../db/database-name';

const SCRATCH_COLLECTION = '_transaction_probe';

async function main(): Promise<void> {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    console.error('MONGODB_URI is not set.');
    process.exitCode = 1;
    return;
  }

  const allowTestDb = process.argv.includes('--allow-test-db');
  try {
    assertNotTestDatabase(uri, allowTestDb);
  } catch (err) {
    console.error((err as Error).message);
    process.exitCode = 1;
    return;
  }

  console.log(`Target database: "${getDatabaseNameFromUri(uri)}"`);
  console.log(`Scratch collection: "${SCRATCH_COLLECTION}" (dropped at the end regardless of outcome)`);

  await mongoose.connect(uri);
  const db = mongoose.connection.db!;
  const collection = db.collection<{ _id: string; value: number }>(SCRATCH_COLLECTION);

  try {
    await collection.insertOne({ _id: 'seed', value: 0 });

    const session = mongoose.connection.getClient().startSession();
    try {
      await session.withTransaction(async () => {
        await collection.insertOne({ _id: 'inserted-in-tx', value: 1 }, { session });
        await collection.updateOne({ _id: 'seed' }, { $set: { value: 2 } }, { session });
      });
      console.log('Transaction committed without error.');
    } finally {
      await session.endSession();
    }

    const seed = await collection.findOne({ _id: 'seed' });
    const inserted = await collection.findOne({ _id: 'inserted-in-tx' });

    const seedUpdated = seed?.value === 2;
    const insertVisible = inserted?.value === 1;

    console.log(`After commit - seed.value updated to 2: ${seedUpdated}`);
    console.log(`After commit - second document visible: ${insertVisible}`);

    if (seedUpdated && insertVisible) {
      console.log('RESULT: transactions work on this cluster.');
    } else {
      console.log('RESULT: transaction reported success, but the data does not look right - treat as NOT working. Investigate before relying on this.');
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.log('RESULT: transactions do NOT work on this cluster.');
    console.log(`Error: ${message}`);
  } finally {
    await collection.drop().catch(() => undefined); // ignore "namespace not found" if nothing was ever created
    await mongoose.disconnect();
  }
}

main().catch((err: unknown) => {
  console.error('check-transactions failed:', err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
