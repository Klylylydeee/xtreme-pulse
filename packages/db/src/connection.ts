import mongoose, { type Mongoose } from 'mongoose';
import { prepareIndexes } from './indexes';

// Spec: docs/adr/0003-mongodb-replica-set.md — MongoDB through Mongoose, always a replica set.

/** Thrown when MONGODB_URI is not set. The message never includes a connection string. */
export class DatabaseNotConfiguredError extends Error {
  constructor() {
    super(
      'MONGODB_URI is not set. Add it to .env.local at the repo root (see .env.example and docs/DEPLOYMENT.md#environment-variables).',
    );
    this.name = 'DatabaseNotConfiguredError';
  }
}

interface ConnectionCache {
  conn: Mongoose | null;
  promise: Promise<Mongoose> | null;
}

// Cached on globalThis so Next's hot reload in development reuses one connection instead of
// opening a new pool every time a module is re-evaluated.
const globalForDb = globalThis as typeof globalThis & { __pulseDb?: ConnectionCache };
const cache: ConnectionCache = (globalForDb.__pulseDb ??= { conn: null, promise: null });

/** True when MONGODB_URI is set. Never exposes the value. */
export function isDatabaseConfigured(): boolean {
  return Boolean(process.env.MONGODB_URI?.trim());
}

/**
 * Connects Mongoose's default connection once per process and returns it. Later calls reuse the
 * same connection. Throws {@link DatabaseNotConfiguredError} when MONGODB_URI is missing.
 *
 * Before returning, it builds the indexes of every model registered so far that doesn't have them
 * yet (see indexes.ts), so writes that follow, including those in a transaction, find them in
 * place. Once they are built this costs nothing. Inside `withTransaction` it never waits.
 */
export async function connectDb(): Promise<Mongoose> {
  if (cache.conn) {
    await prepareIndexes();
    return cache.conn;
  }

  const uri = process.env.MONGODB_URI?.trim();
  if (!uri) throw new DatabaseNotConfiguredError();

  cache.promise ??= mongoose
    .connect(uri, {
      // Fail fast instead of hanging a request when the server is down.
      serverSelectionTimeoutMS: 5_000,
    })
    .catch((error: unknown) => {
      // Let the next call try again instead of caching the failure.
      cache.promise = null;
      throw error;
    });

  const conn = await cache.promise;
  await prepareIndexes();
  cache.conn = conn;
  return conn;
}

/** Closes the connection. For scripts (for example the seed script); the app keeps it open. */
export async function disconnectDb(): Promise<void> {
  const pending = cache.promise;
  cache.conn = null;
  cache.promise = null;
  if (pending) {
    const conn = await pending.catch(() => null);
    await conn?.disconnect();
  }
}

/**
 * Removes anything that looks like a MongoDB connection string from a message, so an error can be
 * shown or logged without leaking credentials. Spec: SECURITY.md#secrets
 */
export function redactConnectionString(message: string): string {
  return message.replace(/mongodb(?:\+srv)?:\/\/[^\s"'<>]+/gi, 'mongodb://[redacted]');
}
