import { Types } from 'mongoose';
import { connectDb, isDatabaseConfigured, redactConnectionString } from './connection';
import { withTransaction } from './transaction';

// Scratch collection for the development health check. Records are removed right after the check.
const HEALTH_COLLECTION = 'devHealthChecks';

export type DatabaseHealth =
  | { status: 'not-configured' }
  | { status: 'unreachable'; error: string }
  | {
      status: 'connected';
      databaseName: string;
      serverVersion: string;
      /** Replica set name, or null when the server is standalone (transactions then fail). */
      replicaSet: string | null;
      /** A test transaction committed and its record was visible afterwards. */
      transactionCommitted: boolean;
      /** A test transaction that threw left no record behind. */
      transactionRolledBack: boolean;
      error: string | null;
    };

class RollbackProbe extends Error {}

function describe(error: unknown): string {
  const message = error instanceof Error ? `${error.name}: ${error.message}` : 'Unknown error';
  return redactConnectionString(message);
}

/**
 * Checks the database for the development `/dev/health` page: connects, reads the replica set,
 * and runs one transaction that commits and one that is rolled back. Never returns the URI.
 */
export async function checkDatabase(): Promise<DatabaseHealth> {
  if (!isDatabaseConfigured()) return { status: 'not-configured' };

  let conn;
  try {
    conn = await connectDb();
  } catch (error) {
    return { status: 'unreachable', error: describe(error) };
  }

  const db = conn.connection.db;
  if (!db) return { status: 'unreachable', error: 'The connection has no database handle.' };

  const result: Extract<DatabaseHealth, { status: 'connected' }> = {
    status: 'connected',
    databaseName: db.databaseName,
    serverVersion: 'unknown',
    replicaSet: null,
    transactionCommitted: false,
    transactionRolledBack: false,
    error: null,
  };

  try {
    const hello = await db.admin().command({ hello: 1 });
    result.replicaSet = typeof hello.setName === 'string' ? hello.setName : null;
    const buildInfo = await db.admin().command({ buildInfo: 1 });
    if (typeof buildInfo.version === 'string') result.serverVersion = buildInfo.version;

    // Create the collection outside a transaction so the transactions below only insert.
    const exists = await db.listCollections({ name: HEALTH_COLLECTION }).hasNext();
    if (!exists) await db.createCollection(HEALTH_COLLECTION);
    const collection = db.collection<{ _id: Types.ObjectId; checkedAt: Date }>(HEALTH_COLLECTION);

    const committedId = new Types.ObjectId();
    try {
      await withTransaction(async (session) => {
        await collection.insertOne({ _id: committedId, checkedAt: new Date() }, { session });
      });
      result.transactionCommitted = (await collection.countDocuments({ _id: committedId })) === 1;
    } finally {
      // Remove the probe even when the check fails part-way; a cleanup error doesn't hide the
      // original one.
      await collection.deleteOne({ _id: committedId }).catch(() => undefined);
    }

    const rolledBackId = new Types.ObjectId();
    try {
      await withTransaction(async (session) => {
        await collection.insertOne({ _id: rolledBackId, checkedAt: new Date() }, { session });
        throw new RollbackProbe('Abort on purpose');
      });
    } catch (error) {
      if (!(error instanceof RollbackProbe)) throw error;
    } finally {
      // Only a failed rollback leaves this probe behind; remove it either way.
      result.transactionRolledBack =
        (await collection.deleteOne({ _id: rolledBackId }).catch(() => null))?.deletedCount === 0;
    }
  } catch (error) {
    result.error = describe(error);
  }

  return result;
}
