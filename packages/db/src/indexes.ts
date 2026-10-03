import { AsyncLocalStorage } from 'node:async_hooks';
import mongoose, { type ClientSession, type Model } from 'mongoose';
import { ensureSensitiveValidator } from './sensitive-validator';

// Index readiness for every model (docs/DATA_MODEL.md relies on unique indexes for document
// numbers, configuration versions and idempotent files). The same step installs the `$jsonSchema`
// validator of a collection with sensitive paths (sensitive-validator.ts, ADR 0012), after its
// indexes: a model is ready only when both are in place, so "indexes" below means both.
//
// Mongoose builds a model's indexes in the background and swallows any error, so a write could
// run before a unique index exists (and slip in the duplicates that then stop it from ever being
// built). Instead:
//
// 1. Up front. `connectDb()` builds the indexes of every model registered so far before it
//    returns, on the first call and again whenever a model was registered since (waiting at most
//    10 s). Every service and `withTransaction` call it first, so indexes are normally in place
//    before any write.
// 2. On a write outside a transaction, the write waits for its model's indexes (safe: it holds
//    no locks while it waits).
// 3. On a write inside a transaction, it never waits. Building an index needs an exclusive lock
//    that the open transaction may be holding, so waiting would stall both until the transaction
//    times out. If the model's indexes aren't ready, the write fails at once: with
//    `IndexBuildError` when the build failed for good, with the last attempt's temporary error
//    (unchanged, so `withTransaction` retries on its `TransientTransactionError` label), or
//    else with `IndexesNotReadyError`. Each failure also starts a new build in the background.
// 4. After a failed build, nothing waits for that model again. Its writes fail fast (with
//    `IndexBuildError` for a build failure), and the build is retried in the background with a
//    growing delay (15 s doubling to 5 min for a build failure, 1 s to 30 s for a temporary
//    error), started by `connectDb()` or a write once the delay has passed. Fixing the data lets
//    the model recover without a restart, and a broken index on a large collection is rebuilt at
//    most every 5 minutes, never on every request.
//
// A new index on a collection that already holds data is built the same way, on the first
// `connectDb()` after the deploy, and requests wait for it. Where that data is large, or could
// break a new unique index, build the index in the release's migration or seed step before the
// app takes traffic, and fix any duplicates first.

// Server errors that mean the index definition or the data is wrong: retrying won't help.
const BUILD_FAILURE_CODES = new Set([
  11000, // DuplicateKey: existing records break a unique index
  67, // CannotCreateIndex
  68, // IndexAlreadyExists
  85, // IndexOptionsConflict
  86, // IndexKeySpecsConflict
  171, // CannotIndexParallelArrays
  197, // InvalidIndexSpecificationOption
  // Installing the sensitive-field validator (sensitive-validator.ts):
  2, // BadValue
  9, // FailedToParse
  13, // Unauthorized: the database user may not run createCollection or collMod
  72, // InvalidOptions
]);

function errorCode(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined;
  return typeof error.code === 'number' ? error.code : undefined;
}

function hasErrorLabels(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const labels = (error as { errorLabels?: unknown; errorLabelSet?: unknown }).errorLabels;
  const labelSet = (error as { errorLabelSet?: unknown }).errorLabelSet;
  return (
    (Array.isArray(labels) && labels.length > 0) || (labelSet instanceof Set && labelSet.size > 0)
  );
}

/** True when a build error is about the index or the data, not a passing network problem. */
function isBuildFailure(error: unknown): boolean {
  if (hasErrorLabels(error)) return false;
  const code = errorCode(error);
  return code !== undefined && BUILD_FAILURE_CODES.has(code);
}

/**
 * Thrown to a write when the collection's indexes or validator can't be built because of the index
 * definition, the data or the database user's rights (for example existing duplicates for a
 * unique index). It is not the write's own duplicate-key error, so code that handles E11000 on
 * insert doesn't mistake it for one. The driver's error is kept as `cause` (it can hold record
 * values: don't send it to the browser). Network and other temporary errors are never wrapped:
 * they are rethrown unchanged, with their labels, so `withTransaction` can retry them.
 */
export class IndexBuildError extends Error {
  readonly collection: string;
  constructor(collection: string, cause: unknown) {
    const codeName =
      typeof cause === 'object' && cause !== null && 'codeName' in cause
        ? String(cause.codeName)
        : `code ${String(errorCode(cause))}`;
    super(
      `The indexes or validator of the "${collection}" collection could not be built (${codeName}), so writes to it are refused. Fix the data, the index definition or the database user's rights; the build is retried automatically.`,
      { cause },
    );
    this.name = 'IndexBuildError';
    this.collection = collection;
  }
}

/**
 * Thrown to a write inside a transaction when its collection's indexes are still being built.
 * The transaction must not wait for them (see above). Nothing was written; try again shortly.
 */
export class IndexesNotReadyError extends Error {
  readonly collection: string;
  constructor(collection: string) {
    super(
      `The indexes of the "${collection}" collection are still being built, so this transaction can't write to it yet. Try again in a moment.`,
    );
    this.name = 'IndexesNotReadyError';
    this.collection = collection;
  }
}

// Retry delays after a failed build. A build over a large collection is expensive, so a failure
// that retrying won't fix is retried rarely; a temporary one sooner. Both double per failure.
const RETRY_AFTER_BUILD_FAILURE = { firstMs: 15_000, maxMs: 5 * 60_000 };
const RETRY_AFTER_TEMPORARY_ERROR = { firstMs: 1_000, maxMs: 30_000 };
/** The longest `connectDb()` waits for first builds; slower ones finish in the background. */
const CONNECT_WAIT_MS = 10_000;

interface IndexState {
  ready: boolean;
  /** The build in progress, if any. */
  pending: Promise<void> | null;
  /** The last build failure that retrying won't fix, until a build succeeds. */
  failure: IndexBuildError | null;
  /** The last attempt's temporary error (network, server selection), until a build succeeds. */
  transient: unknown;
  /** Failed attempts in a row, for the backoff. */
  failedAttempts: number;
  /** When the next retry may start (epoch ms). */
  retryAt: number;
  /** `connectDb()` already waited its limit for this build: it doesn't wait for it again. */
  slow: boolean;
}

// Keyed by model object: Next's hot reload replaces a model, and the new one is built afresh.
// On globalThis so a re-evaluated copy of this file shares it.
const globalForIndexes = globalThis as typeof globalThis & {
  __pulseIndexes?: WeakMap<Model<unknown>, IndexState>;
};
const states = (globalForIndexes.__pulseIndexes ??= new WeakMap());

function stateOf(model: Model<unknown>): IndexState {
  let state = states.get(model);
  if (!state) {
    state = {
      ready: false,
      pending: null,
      failure: null,
      transient: null,
      failedAttempts: 0,
      retryAt: 0,
      slow: false,
    };
    states.set(model, state);
  }
  return state;
}

function hasFailed(state: IndexState): boolean {
  return state.failure !== null || state.transient !== null;
}

function recordFailure(state: IndexState, delays: { firstMs: number; maxMs: number }): void {
  state.failedAttempts += 1;
  const delay = Math.min(delays.firstMs * 2 ** (state.failedAttempts - 1), delays.maxMs);
  state.retryAt = Date.now() + delay;
}

/**
 * Builds `model`'s indexes and resolves when they exist; one build at a time per model. Rejects
 * with {@link IndexBuildError} for a build failure, or with the original error (labels intact) for
 * a network or other temporary problem. Failures are kept (see `retryIfDue`), never final.
 */
export function ensureModelIndexes(model: Model<unknown>): Promise<void> {
  const state = stateOf(model);
  if (state.ready) return Promise.resolve();
  state.pending ??= (async () => {
    try {
      try {
        // The build Mongoose started when the model was defined (it creates the collection too).
        await model.init();
      } catch {
        // `init()` keeps its first result, so build again to learn the current state.
        await model.createIndexes();
      }
      // Then the sensitive-field validator, when the schema has sensitive paths.
      await ensureSensitiveValidator(model);
      state.ready = true;
      state.failure = null;
      state.transient = null;
      state.failedAttempts = 0;
    } catch (error) {
      if (!isBuildFailure(error)) {
        state.transient = error;
        recordFailure(state, RETRY_AFTER_TEMPORARY_ERROR);
        throw error;
      }
      state.failure = new IndexBuildError(model.collection.collectionName, error);
      recordFailure(state, RETRY_AFTER_BUILD_FAILURE);
      throw state.failure;
    } finally {
      state.pending = null;
    }
  })();
  return state.pending;
}

/** Starts a new build in the background once the backoff since the last failure has passed. */
function retryIfDue(model: Model<unknown>, state: IndexState): void {
  if (state.pending || Date.now() < state.retryAt) return;
  ensureModelIndexes(model).catch(() => undefined);
}

/**
 * For `connectDb()`: builds the indexes of every registered model that isn't ready yet.
 *
 * - A model that has never been built is waited for (at most `CONNECT_WAIT_MS` in all; a slower
 *   build carries on in the background, later calls don't wait for it again, and that model's
 *   writes stay gated by `beforeWrite`).
 * - A model whose last build failed is not waited for: its retry starts in the background once its
 *   backoff has passed, so one broken collection never slows the rest of the app.
 */
export async function ensureRegisteredIndexes(): Promise<void> {
  const waiting: Promise<void>[] = [];
  const waitedFor: IndexState[] = [];
  for (const name of mongoose.modelNames()) {
    const model = mongoose.model(name) as Model<unknown>;
    const state = stateOf(model);
    if (state.ready) continue;
    if (hasFailed(state)) {
      retryIfDue(model, state);
      continue;
    }
    if (state.slow) continue;
    waiting.push(ensureModelIndexes(model).catch(() => undefined));
    waitedFor.push(state);
  }
  if (!waiting.length) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, CONNECT_WAIT_MS);
  });
  try {
    await Promise.race([Promise.all(waiting), timeout]);
  } finally {
    clearTimeout(timer);
  }
  for (const state of waitedFor) if (state.pending) state.slow = true;
}

function inTransaction(session: ClientSession | null | undefined): boolean {
  return typeof session?.inTransaction === 'function' && session.inTransaction();
}

/**
 * The check before a write on `model`.
 *
 * - After a build failure that retrying won't fix, it throws {@link IndexBuildError} at once, in
 *   or outside a transaction, and starts a retry in the background when one is due.
 * - Otherwise, outside a transaction it waits for the indexes; inside one it never waits and
 *   throws when they aren't ready (see the header).
 */
export async function beforeWrite(
  model: Model<unknown>,
  session: ClientSession | null | undefined,
): Promise<void> {
  const state = stateOf(model);
  if (state.ready) return;
  if (state.failure) {
    retryIfDue(model, state);
    throw state.failure;
  }
  if (!inTransaction(session)) return ensureModelIndexes(model);
  // Start (or keep) the build in the background so a retry after this transaction succeeds.
  ensureModelIndexes(model).catch(() => undefined);
  // The last attempt hit a temporary error: throw it unchanged, labels included, so
  // `withTransaction` retries the transaction (by then the new attempt may have built them).
  if (state.transient) throw state.transient;
  throw new IndexesNotReadyError(model.collection.collectionName);
}

// Marks code running inside a `withTransaction` callback, so `connectDb()` called from there never
// waits. The mark is switched off when the callback settles: promises the callback started and
// didn't await inherit the scope, and must not be treated as inside the transaction afterwards.
const transactionScope = new AsyncLocalStorage<{ active: boolean }>();

/** Runs `work` marked as inside a transaction. Used by `withTransaction`. */
export async function runInTransactionScope<T>(work: () => Promise<T>): Promise<T> {
  const mark = { active: true };
  try {
    return await transactionScope.run(mark, work);
  } finally {
    mark.active = false;
  }
}

/**
 * For `connectDb()`: builds missing indexes, but inside a transaction only starts the builds and
 * doesn't wait (the writes there fail fast if it matters).
 */
export async function prepareIndexes(): Promise<void> {
  if (transactionScope.getStore()?.active) {
    void ensureRegisteredIndexes();
    return;
  }
  await ensureRegisteredIndexes();
}
