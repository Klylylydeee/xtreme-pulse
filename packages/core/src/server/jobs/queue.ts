import { Queue, type JobsOptions } from 'bullmq';
import { Redis } from 'ioredis';
import type { z } from 'zod';
import {
  describeJobError,
  JOB_KEY_PREFIX,
  JOB_QUEUE_NAME,
  JobsUnavailableError,
  isRedisAuthError,
  redisUrl,
} from './connection';
import type { JobDefinition } from './define';

const DAY_SECONDS = 24 * 60 * 60;

/**
 * How long adding a job waits for Redis before giving up with `JobsUnavailableError`, so a Server
 * Action never hangs while Redis is down.
 */
const ENQUEUE_TIMEOUT_MS = 3_000;

/** BullMQ options for one run of `job`: its retries plus how long finished runs are kept. */
export function jobRunOptions(job: JobDefinition): JobsOptions {
  return {
    attempts: job.attempts,
    backoff: { ...job.backoff },
    // Keep a week of finished runs and a month of failed ones for troubleshooting.
    removeOnComplete: { age: 7 * DAY_SECONDS, count: 1_000 },
    removeOnFail: { age: 30 * DAY_SECONDS },
  };
}

interface QueueCache {
  queue: Queue | null;
  connection: Redis | null;
  lastErrorLog: number;
  /** The client's last error was a refused password or ACL permission (cleared on connect). */
  authFailed: boolean;
}

// Cached on globalThis so Next's hot reload reuses one queue connection.
const globalForJobs = globalThis as typeof globalThis & { __pulseJobQueue?: QueueCache };
const cache: QueueCache = (globalForJobs.__pulseJobQueue ??= {
  queue: null,
  connection: null,
  lastErrorLog: 0,
  authFailed: false,
});

/** The error to throw now: an auth problem if Redis last refused the login, else unreachable. */
function unavailable(): JobsUnavailableError {
  return new JobsUnavailableError(cache.authFailed ? 'auth' : 'unreachable');
}

/**
 * The shared queue for adding jobs. It connects on first use, so pages that never enqueue never
 * touch Redis. Throws `JobsNotConfiguredError` when REDIS_URL is not set.
 *
 * While Redis is down the client keeps reconnecting in the background (so the queue recovers by
 * itself once Redis is back), but BullMQ calls on it wait for that. Code that must not wait goes
 * through `enqueueJob`, which gives up after a few seconds.
 */
export function jobQueue(): Queue {
  if (cache.queue && cache.connection) return cache.queue;
  // A queue cached without its connection comes from older code before a hot reload: replace it.
  if (cache.queue) resetJobQueue();
  // BullMQ is given a client instance, not options: its ESM build can't load ioredis by itself.
  // Commands fail at once while disconnected instead of queueing in memory until Redis is back.
  const connection = new Redis(redisUrl(), { enableOfflineQueue: false, maxRetriesPerRequest: 1 });
  const queue = new Queue(JOB_QUEUE_NAME, { prefix: JOB_KEY_PREFIX, connection });
  const onError = (error: unknown) => {
    cache.authFailed = isRedisAuthError(error);
    // At most one line a minute while Redis is down; never the URL, the user or the password
    // (describeJobError gives auth and ACL refusals a fixed line).
    const at = Date.now();
    if (at - cache.lastErrorLog < 60_000) return;
    cache.lastErrorLog = at;
    console.error(`Job queue: ${describeJobError(error)}`);
  };
  connection.on('error', onError);
  connection.on('ready', () => {
    cache.authFailed = false;
  });
  queue.on('error', onError);
  cache.queue = queue;
  cache.connection = connection;
  return queue;
}

/** Drops the cached queue so the next call builds a new one. */
function resetJobQueue(): void {
  const { queue } = cache;
  // The client handed to BullMQ, which `close()` leaves open because it didn't create it.
  const connection = cache.connection ?? queue?.opts.connection;
  cache.queue = null;
  cache.connection = null;
  void queue?.close().catch(() => undefined);
  if (connection instanceof Redis) connection.disconnect();
}

/** Settles like `work`, or rejects with `JobsUnavailableError` once `deadline` (epoch ms) passes. */
async function beforeDeadline<T>(work: Promise<T>, deadline: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(unavailable()), Math.max(0, deadline - Date.now()));
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** Resolves once the client is connected, or rejects with `JobsUnavailableError` at `deadline`. */
function connected(connection: Redis, deadline: number): Promise<void> {
  if (connection.status === 'ready') return Promise.resolve();
  let onReady: (() => void) | undefined;
  const ready = new Promise<void>((resolve) => {
    onReady = resolve;
    connection.once('ready', resolve);
  });
  return beforeDeadline(ready, deadline).finally(() => {
    if (onReady) connection.off('ready', onReady);
  });
}

/**
 * The queue, connected and ready for commands, or `JobsUnavailableError` by `deadline`. Nothing is
 * sent before the connection is ready, so a refused enqueue never adds its job later.
 */
async function readyJobQueue(deadline: number): Promise<{ queue: Queue; connection: Redis }> {
  const queue = jobQueue();
  const connection = cache.connection;
  if (!connection) throw new Error('The job queue has no connection.');
  try {
    // BullMQ's first-use setup (it waits for the first connection, then checks the version).
    await beforeDeadline(queue.waitUntilReady(), deadline);
  } catch (error) {
    if (error instanceof JobsUnavailableError) throw error;
    if (isRedisAuthError(error)) throw new JobsUnavailableError('auth');
    // The setup failed for good (for example the connection was closed): start over next time.
    resetJobQueue();
    throw error;
  }
  // Redis may have gone away since: wait for the client to reconnect.
  await connected(connection, deadline);
  return { queue, connection };
}

// BullMQ job ids can't contain `:` or be a plain integer.
const JOB_ID = /^(?!\d+$)[A-Za-z0-9._-]{1,200}$/;

export interface EnqueueOptions {
  /**
   * Makes the enqueue idempotent: while a job with this id is still kept (queued, running or
   * recently finished), adding it again returns that job instead of a new one. Letters, digits,
   * `.`, `_` and `-` only, for example `desk.slaTimer-<ticketId>`.
   */
  jobId?: string;
  /** Run no sooner than this many milliseconds from now. */
  delayMs?: number;
}

export interface EnqueuedJob {
  id: string;
  name: string;
}

/**
 * Adds a job for the worker. `data` is checked against the job's schema first. Call it after the
 * transaction that makes the job necessary has committed, never inside one (the callback can run
 * more than once).
 *
 * Throws `JobsNotConfiguredError` when REDIS_URL is not set, and `JobsUnavailableError` when Redis
 * can't be reached within a few seconds or refuses the app's password or permissions. In the rare case Redis stops answering while the job is
 * being added, the job may still have been added; pass a `jobId` where adding it twice matters, so
 * trying again is safe.
 */
export async function enqueueJob<TSchema extends z.ZodType>(
  job: JobDefinition<TSchema>,
  data: z.input<TSchema>,
  { jobId, delayMs }: EnqueueOptions = {},
): Promise<EnqueuedJob> {
  const parsed = job.schema.safeParse(data);
  if (!parsed.success) throw new Error(`The data for job "${job.name}" doesn't match its schema.`);
  if (jobId !== undefined && !JOB_ID.test(jobId)) {
    throw new Error(`"${jobId}" is not a job id. Use letters, digits, ".", "_" and "-".`);
  }
  const deadline = Date.now() + ENQUEUE_TIMEOUT_MS;
  const { queue, connection } = await readyJobQueue(deadline);
  let added;
  try {
    added = await beforeDeadline(
      queue.add(job.name, parsed.data, { ...jobRunOptions(job), jobId, delay: delayMs }),
      // A connected Redis answers in milliseconds; this only stops a stalled connection.
      Math.max(deadline, Date.now() + 1_000),
    );
  } catch (error) {
    if (error instanceof JobsUnavailableError) throw error;
    // Redis refused the command (an ACL without the needed permissions). The reply names the
    // user, so it isn't passed on.
    if (isRedisAuthError(error)) throw new JobsUnavailableError('auth');
    // The connection dropped mid-way (commands fail at once while disconnected).
    if (connection.status !== 'ready') throw unavailable();
    throw error;
  }
  if (!added.id) throw new Error(`The queue returned no id for job "${job.name}".`);
  return { id: added.id, name: job.name };
}
