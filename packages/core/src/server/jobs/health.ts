import type { Job } from 'bullmq';
import {
  createProbeClient,
  describeJobError,
  isJobsConfigured,
  isRedisAuthError,
  JOB_KEY_PREFIX,
  JOB_QUEUE_NAME,
  WORKER_HEARTBEAT_KEY,
} from './connection';
import { jobQueue } from './queue';

export interface WorkerHeartbeat {
  pid: number;
  host: string;
  startedAt: Date;
  beatAt: Date;
}

export interface ScheduleInfo {
  id: string;
  jobName: string;
  pattern: string | null;
  timeZone: string | null;
  nextRunAt: Date | null;
}

export type RedisHealth =
  | { status: 'not-configured' }
  | { status: 'unreachable'; error: string }
  /**
   * Redis answered but refused the app: `login` for a wrong or missing password or unknown user,
   * `permissions` for an ACL user that can't run what BullMQ needs (scripts that write keys).
   */
  | { status: 'refused'; problem: 'login' | 'permissions' }
  | {
      status: 'connected';
      serverVersion: string;
      /** BullMQ needs `noeviction`; null when the server doesn't allow reading it. */
      evictionPolicy: string | null;
      /** The worker's last heartbeat, or null when no worker is running. */
      worker: WorkerHeartbeat | null;
      schedules: ScheduleInfo[];
      error: string | null;
    };

function parseHeartbeat(value: string | null): WorkerHeartbeat | null {
  if (!value) return null;
  try {
    const raw = JSON.parse(value) as Record<string, unknown>;
    return {
      pid: Number(raw.pid),
      host: String(raw.host),
      startedAt: new Date(String(raw.startedAt)),
      beatAt: new Date(String(raw.beatAt)),
    };
  } catch {
    return null;
  }
}

// Inside the queue's own key space (`pulse:jobs:`), so a user scoped to BullMQ's keys passes. Job
// ids from enqueueJob can't contain `:`, and BullMQ's own keys never start with `health:`.
const PERMISSION_PROBE_KEY = `${JOB_KEY_PREFIX}:${JOB_QUEUE_NAME}:health:permissionProbe`;

/**
 * Runs what BullMQ does all the time: a Lua script that writes and deletes a key in the queue's
 * key space (the key expires after 5 s even if the delete never runs). An ACL user without scripting or write access fails here with NOPERM, instead of every
 * enqueue failing later. (It doesn't try every command BullMQ's scripts use.)
 */
async function probePermissions(client: ReturnType<typeof createProbeClient>): Promise<void> {
  await client.eval(
    "redis.call('SET', KEYS[1], '1', 'PX', 5000) return redis.call('DEL', KEYS[1])",
    1,
    PERMISSION_PROBE_KEY,
  );
}

/** Checks Redis and the worker for `/dev/health`. Never throws and never returns the URL. */
export async function checkRedis(): Promise<RedisHealth> {
  if (!isJobsConfigured()) return { status: 'not-configured' };
  const client = createProbeClient();
  // A refused login closes the connection, and connect() then only says "Connection is closed":
  // keep the client's own error to tell the two apart.
  let clientError: unknown = null;
  client.on('error', (error: unknown) => {
    clientError = error;
  });
  try {
    await client.connect();
  } catch (error) {
    client.disconnect();
    if (isRedisAuthError(error) || isRedisAuthError(clientError)) {
      return { status: 'refused', problem: 'login' };
    }
    // connect() only says "Connection is closed"; the client's own error has the cause.
    return { status: 'unreachable', error: describeJobError(clientError ?? error) };
  }
  try {
    await probePermissions(client);
  } catch (error) {
    client.disconnect();
    if (isRedisAuthError(error)) return { status: 'refused', problem: 'permissions' };
    return { status: 'unreachable', error: describeJobError(error) };
  }
  const result: Extract<RedisHealth, { status: 'connected' }> = {
    status: 'connected',
    serverVersion: 'unknown',
    evictionPolicy: null,
    worker: null,
    schedules: [],
    error: null,
  };
  try {
    const info = await client.info('server');
    result.serverVersion = /redis_version:([^\r\n]+)/.exec(info)?.[1] ?? 'unknown';
    const policy = await client.config('GET', 'maxmemory-policy').catch(() => null);
    if (Array.isArray(policy) && typeof policy[1] === 'string') result.evictionPolicy = policy[1];
    result.worker = parseHeartbeat(await client.get(WORKER_HEARTBEAT_KEY));
    const schedulers = await jobQueue().getJobSchedulers();
    result.schedules = schedulers.map((scheduler) => ({
      id: scheduler.id ?? scheduler.key,
      jobName: scheduler.name,
      pattern: scheduler.pattern ?? null,
      timeZone: scheduler.tz ?? null,
      nextRunAt: scheduler.next ? new Date(scheduler.next) : null,
    }));
  } catch (error) {
    result.error = describeJobError(error);
  } finally {
    client.disconnect();
  }
  return result;
}

export type JobRunState =
  | { state: 'completed'; ms: number; result: unknown }
  | { state: 'failed'; ms: number; error: string }
  | { state: 'waiting'; ms: number; detail: string };

/**
 * Waits up to `timeoutMs` for an enqueued job to finish, for development checks. Polls the job's
 * state, so it needs no extra connection.
 */
export async function waitForJob(jobId: string, timeoutMs: number): Promise<JobRunState> {
  const started = Date.now();
  let job: Job | undefined;
  for (;;) {
    job = (await jobQueue().getJob(jobId)) as Job | undefined;
    if (!job) {
      return {
        state: 'failed',
        ms: Date.now() - started,
        error: 'The job is no longer in the queue.',
      };
    }
    const state = await job.getState();
    const ms = Date.now() - started;
    if (state === 'completed') {
      return { state: 'completed', ms, result: job.returnvalue };
    }
    if (state === 'failed') {
      return { state: 'failed', ms, error: job.failedReason ?? 'Failed' };
    }
    if (ms >= timeoutMs) {
      return {
        state: 'waiting',
        ms,
        detail: `Still ${state} after ${Math.round(ms / 100) / 10} s`,
      };
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
}
