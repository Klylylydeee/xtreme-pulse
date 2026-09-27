import type { ClientSession, mongo } from 'mongoose';
import { connectDb } from './connection';
import { runInTransactionScope } from './indexes';

// Spec: docs/DATA_MODEL.md#money — any operation touching more than one collection runs inside a
// MongoDB transaction (`session.withTransaction`).

const DEFAULT_TRANSACTION_OPTIONS: mongo.TransactionOptions = {
  readConcern: { level: 'snapshot' },
  writeConcern: { w: 'majority' },
  readPreference: 'primary',
};

/**
 * Runs `work` inside a MongoDB transaction and returns its result.
 *
 * Built on `session.withTransaction`, which commits when `work` resolves, aborts when it throws
 * (the error is re-thrown), and retries the whole callback on `TransientTransactionError` and the
 * commit on `UnknownTransactionCommitResult`. Because of those retries, `work` may run more than
 * once: keep it to database calls, pass `session` to every one of them, and do side effects
 * (emails, jobs, files) after this function returns.
 */
export async function withTransaction<T>(
  work: (session: ClientSession) => Promise<T>,
  options: mongo.TransactionOptions = {},
): Promise<T> {
  const conn = await connectDb();
  const session = await conn.startSession();
  try {
    // Marked so `connectDb()` inside never waits for an index build (see indexes.ts).
    return await session.withTransaction(() => runInTransactionScope(() => work(session)), {
      ...DEFAULT_TRANSACTION_OPTIONS,
      ...options,
    });
  } finally {
    await session.endSession();
  }
}
