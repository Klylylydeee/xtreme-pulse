import { hostname } from 'node:os';
import { Queue, UnrecoverableError, Worker, type Job } from 'bullmq';
import { Redis } from 'ioredis';
import type { z } from 'zod';
import {
  describeJobError,
  isRedisAuthError,
  JOB_KEY_PREFIX,
  JOB_QUEUE_NAME,
  redisUrl,
  WORKER_HEARTBEAT_EVERY_MS,
  WORKER_HEARTBEAT_KEY,
  WORKER_HEARTBEAT_TTL_MS,
} from './connection';
import { type JobDefinition, SCHEDULE_TIME_ZONE, type ScheduleDefinition } from './define';
import { jobRunOptions } from './queue';

// The worker process's side of the jobs (apps/worker). Only the worker imports this file.

/** How long each close waits when a failed start is cleaned up. */
const CLOSE_TIMEOUT_MS = 2_000;

/** Settles when `work` does or after `ms`, whichever is first. */
function withinMs(work: Promise<unknown>, ms: number): Promise<unknown> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(resolve, ms);
  });
  return Promise.race([work.catch(() => undefined), timeout]).finally(() => clearTimeout(timer));
}

/** What a handler learns about the run it is in. */
export interface JobContext {
  jobId: string;
  /** 1 on the first try, 2 on the first retry, and so on. */
  attempt: number;
  /** Total tries allowed. */
  attempts: number;
}

export interface JobHandler {
  readonly job: JobDefinition;
  readonly run: (data: unknown, context: JobContext) => Promise<unknown>;
}

/**
 * Pairs a job with the function that runs it. The function gets the data already checked against
 * the job's schema. It must be idempotent (see define.ts). Throw to fail the attempt (it is
 * retried with the job's backoff); throw `UnrecoverableError` from bullmq to fail without retries.
 * Return a small, non-sensitive result or nothing: it is kept in Redis.
 */
export function handleJob<TSchema extends z.ZodType>(
  job: JobDefinition<TSchema>,
  run: (data: z.output<TSchema>, context: JobContext) => Promise<unknown>,
): JobHandler {
  return Object.freeze({
    job,
    run: (data: unknown, context: JobContext) => {
      const parsed = job.schema.safeParse(data);
      if (!parsed.success) {
        throw new UnrecoverableError(`The data for job "${job.name}" doesn't match its schema.`);
      }
      return run(parsed.data, context);
    },
  });
}

export interface JobLogger {
  info(message: string): void;
  error(message: string): void;
}

export interface StartJobWorkerOptions {
  handlers: readonly JobHandler[];
  /** Registered on start. Schedules registered earlier but missing here are removed. */
  schedules: readonly ScheduleDefinition[];
  /** Jobs run at the same time. */
  concurrency?: number;
  logger?: JobLogger;
}

export interface RunningJobWorker {
  /** Stops taking jobs, waits for running ones, and disconnects. */
  close(): Promise<void>;
}

/**
 * Registers the schedules with BullMQ's job schedulers, on Asia/Manila time. Upserting is
 * idempotent, so every worker start (and several workers) can run it safely.
 */
async function registerSchedules(
  queue: Queue,
  schedules: readonly ScheduleDefinition[],
  logger: JobLogger,
): Promise<void> {
  const ids = new Set<string>();
  for (const schedule of schedules) {
    if (ids.has(schedule.id)) throw new Error(`Schedule "${schedule.id}" is listed twice.`);
    ids.add(schedule.id);
    await queue.upsertJobScheduler(
      schedule.id,
      { pattern: schedule.pattern, tz: SCHEDULE_TIME_ZONE },
      {
        name: schedule.job.name,
        data: schedule.job.schema.parse(schedule.data),
        opts: jobRunOptions(schedule.job),
      },
    );
    logger.info(`Schedule ${schedule.id}: "${schedule.pattern}" (${SCHEDULE_TIME_ZONE})`);
  }
  // A schedule deleted from the code must stop running.
  for (const existing of await queue.getJobSchedulers()) {
    const id = existing.id ?? existing.key;
    if (!ids.has(id)) {
      await queue.removeJobScheduler(id);
      logger.info(`Schedule ${id}: removed (no longer defined)`);
    }
  }
}

/**
 * Starts the worker: registers schedules, takes jobs, and keeps the heartbeat fresh. While Redis
 * is down it waits for it; if Redis refuses the password or permissions during startup, it
 * closes what it opened and throws, so the process can exit.
 */
export async function startJobWorker({
  handlers,
  schedules,
  concurrency = 5,
  logger = console,
}: StartJobWorkerOptions): Promise<RunningJobWorker> {
  const url = redisUrl();
  const byName = new Map<string, JobHandler>();
  for (const handler of handlers) {
    if (byName.has(handler.job.name))
      throw new Error(`Job "${handler.job.name}" has two handlers.`);
    byName.set(handler.job.name, handler);
  }
  for (const schedule of schedules) {
    if (!byName.has(schedule.job.name)) {
      throw new Error(
        `Schedule "${schedule.id}" runs "${schedule.job.name}", which has no handler.`,
      );
    }
  }

  let lastErrorLog = 0;
  const logConnectionError = (source: string, error: unknown) => {
    // At most one line every 30 s while Redis is down; never the URL.
    const at = Date.now();
    if (at - lastErrorLog < 30_000) return;
    lastErrorLog = at;
    logger.error(`${source}: ${describeJobError(error)}`);
  };

  // A refused password or ACL permission can't fix itself while the worker runs (REDIS_URL is read
  // once), so during startup it fails the start instead of retrying forever. Afterwards it is
  // only logged, like any other connection error.
  let starting = true;
  let refuseStart: (error: unknown) => void = () => undefined;
  const startRefused = new Promise<never>((_, reject) => {
    refuseStart = reject;
  });
  startRefused.catch(() => undefined);
  const onConnectionError = (source: string, error: unknown) => {
    if (starting && isRedisAuthError(error)) refuseStart(error);
    logConnectionError(source, error);
  };

  // One client for the queue, the worker and the heartbeat; the worker duplicates it for its
  // blocking connection. BullMQ is given an instance because its ESM build can't load ioredis by
  // itself. Workers must retry Redis commands forever (maxRetriesPerRequest: null).
  const connection = new Redis(url, { maxRetriesPerRequest: null });
  connection.on('error', (error) => onConnectionError('Redis', error));
  const queue = new Queue(JOB_QUEUE_NAME, { prefix: JOB_KEY_PREFIX, connection });
  queue.on('error', (error) => onConnectionError('Queue', error));
  let worker: Worker | null = null;
  let timer: ReturnType<typeof setInterval> | undefined;

  const start = async (): Promise<Worker> => {
    await registerSchedules(queue, schedules, logger);
    const started = new Worker(
      JOB_QUEUE_NAME,
      async (job: Job) => {
        const handler = byName.get(job.name);
        if (!handler) throw new UnrecoverableError(`No handler for job "${job.name}".`);
        return handler.run(job.data, {
          jobId: job.id ?? '',
          attempt: job.attemptsMade + 1,
          attempts: job.opts.attempts ?? 1,
        });
      },
      {
        prefix: JOB_KEY_PREFIX,
        connection,
        concurrency,
      },
    );
    worker = started;
    // Log names, ids and attempts only: never job data or results, which could hold record
    // details.
    started.on('completed', (job) => {
      logger.info(`Job ${job.name} ${job.id} done (attempt ${job.attemptsMade})`);
    });
    started.on('failed', (job, error) => {
      if (!job) return;
      const attempts = job.opts.attempts ?? 1;
      const final = job.attemptsMade >= attempts || error instanceof UnrecoverableError;
      logger.error(
        `Job ${job.name} ${job.id} attempt ${job.attemptsMade}/${attempts} failed${final ? '' : ', will retry'}: ${describeJobError(error)}`,
      );
    });
    started.on('error', (error) => onConnectionError('Worker', error));

    const startedAt = new Date().toISOString();
    const beat = () => {
      const value = JSON.stringify({
        pid: process.pid,
        host: hostname(),
        startedAt,
        beatAt: new Date().toISOString(),
      });
      connection
        .set(WORKER_HEARTBEAT_KEY, value, 'PX', WORKER_HEARTBEAT_TTL_MS)
        .catch(() => undefined);
    };
    beat();
    timer = setInterval(beat, WORKER_HEARTBEAT_EVERY_MS);

    await started.waitUntilReady();
    return started;
  };

  let running: Worker;
  try {
    running = await Promise.race([start(), startRefused]);
  } catch (error) {
    // Close everything this call opened, so the process can exit. Each close gets a few seconds:
    // one waiting on a refused connection must not hold the exit up.
    clearInterval(timer);
    // Set inside start(), which TypeScript can't see from here.
    const opened = worker as Worker | null;
    await Promise.allSettled([
      withinMs(opened ? opened.close(true) : Promise.resolve(), CLOSE_TIMEOUT_MS),
      withinMs(queue.close(), CLOSE_TIMEOUT_MS),
    ]);
    connection.disconnect();
    throw error;
  }
  starting = false;
  logger.info(
    `Worker ready: ${byName.size} job type(s), ${schedules.length} schedule(s), concurrency ${concurrency}`,
  );

  return {
    async close() {
      clearInterval(timer);
      await running.close();
      await connection.del(WORKER_HEARTBEAT_KEY).catch(() => undefined);
      await queue.close();
      connection.disconnect();
    },
  };
}
