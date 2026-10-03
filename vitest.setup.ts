import { randomBytes, randomInt } from 'node:crypto';
import { afterAll, inject } from 'vitest';
import { databaseNameOf, TEST_DB_PREFIX, withDatabaseName } from './vitest.test-db';

// Runs before each test file, in that file's own process: gives the file its own database on the
// test replica set and a throwaway master key, and drops the database afterwards. Nothing here
// reads `.env.local`, and the development database (`xtreme-pulse`) is refused.

const baseUri = inject('pulseTestMongoUri');
const baseName = databaseNameOf(baseUri) ?? `${TEST_DB_PREFIX}base`;
const dbName = `${baseName}-${process.pid}-${randomInt(1_000_000)}`;
if (!dbName.startsWith(TEST_DB_PREFIX) || dbName === 'xtreme-pulse') {
  throw new Error(`Refusing to run tests against the database "${dbName}".`);
}

process.env.MONGODB_URI = withDatabaseName(baseUri, dbName);
process.env.FIELD_ENCRYPTION_LOCAL_KEY = randomBytes(96).toString('base64');

afterAll(async () => {
  const { default: mongoose } = await import('mongoose');
  const { disconnectDb } = await import('@pulse/db');
  const db = mongoose.connection.db;
  if (db && db.databaseName.startsWith(TEST_DB_PREFIX)) await db.dropDatabase();
  await disconnectDb();
  await mongoose.disconnect();
});
