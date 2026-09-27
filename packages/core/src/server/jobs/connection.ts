import { Redis } from 'ioredis';

// Spec: docs/adr/0009-background-jobs-bullmq.md and docs/ARCHITECTURE.md#background-jobs — one
// BullMQ queue on Redis (`REDIS_URL`), worked by the separate worker process (apps/worker).

/** The BullMQ key prefix: every key the app writes to Redis starts with `pulse:`. */
export const JOB_KEY_PREFIX = 'pulse';
/** The one queue every job goes through. The job name picks the handler. */
export const JOB_QUEUE_NAME = 'jobs';
/** The worker refreshes this key while it runs, so `/dev/health` can tell it is up. */
export const WORKER_HEARTBEAT_KEY = `${JOB_KEY_PREFIX}:worker:heartbeat`;
/** How often the worker refreshes its heartbeat, and how long one lasts. */
export const WORKER_HEARTBEAT_EVERY_MS = 10_000;
export const WORKER_HEARTBEAT_TTL_MS = 30_000;

/** Thrown when REDIS_URL is not set. The message never includes a connection string. */
export class JobsNotConfiguredError extends Error {
  constructor() {
    super(
      'REDIS_URL is not set, so background jobs are off. Add it to .env.local at the repo root (see .env.example and docs/DEPLOYMENT.md#environment-variables).',
    );
    this.name = 'JobsNotConfiguredError';
  }
}

/** Why jobs couldn't be added: Redis didn't answer, or it refused the app's login or permissions. */
export type JobsUnavailableReason = 'unreachable' | 'auth';

const UNAVAILABLE_MESSAGES: Record<JobsUnavailableReason, string> = {
  unreachable:
    "Can't reach Redis, so the background job wasn't queued. Check that Redis is running, then try again.",
  auth: "Redis refused the app's password or permissions, so the background job wasn't queued. Check the user and password in REDIS_URL and that user's ACL permissions.",
};

/**
 * Thrown when REDIS_URL is set but the job couldn't be added: Redis can't be reached within a few
 * seconds (`reason: 'unreachable'`), or it refused the login or a command (`reason: 'auth'`). The
 * caller can show the message and let the user try again. It carries no `cause`: the Redis
 * client's own errors can name the host or the user, and this error may be logged or shown.
 */
export class JobsUnavailableError extends Error {
  readonly reason: JobsUnavailableReason;
  constructor(reason: JobsUnavailableReason = 'unreachable') {
    super(UNAVAILABLE_MESSAGES[reason]);
    this.name = 'JobsUnavailableError';
    this.reason = reason;
  }
}

/**
 * True for Redis replies that mean a wrong or missing password, or an ACL refusal (also when a
 * Lua script hits one). Such replies can name the ACL user, so they're never logged as they are.
 */
export function isRedisAuthError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : '';
  return /\b(?:NOAUTH|WRONGPASS|NOPERM)\b|\binvalid (?:username-)?password\b|\bERR AUTH\b|\bACL failure\b|\bno permissions\b/i.test(
    message,
  );
}

/** The fixed text logged and shown for {@link isRedisAuthError} errors, without the user name. */
export const REDIS_AUTH_ERROR_TEXT = "Redis refused the app's password or permissions.";

/** True when REDIS_URL is set. Never exposes the value. */
export function isJobsConfigured(): boolean {
  return Boolean(process.env.REDIS_URL?.trim());
}

/** REDIS_URL, or throws {@link JobsNotConfiguredError}. Never log the value: it can hold a password. */
export function redisUrl(): string {
  const url = process.env.REDIS_URL?.trim();
  if (!url) throw new JobsNotConfiguredError();
  return url;
}

/** Removes anything that looks like a Redis connection string from a message. */
export function redactRedisUrl(message: string): string {
  return message.replace(/rediss?:\/\/[^\s"'<>]+/gi, 'redis://[redacted]');
}

/** A Node system error's code (`ECONNREFUSED`, `ENOTFOUND`, `ETIMEDOUT`…), or null. */
function systemErrorCode(error: unknown): string | null {
  if (!(error instanceof Error)) return null;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' && /^E[A-Z_]+$/.test(code) ? code : null;
}

/**
 * An error as `Name: message` with connection strings removed, safe to log or show. A refused
 * password or ACL permission becomes fixed text, because Redis's reply can name the user.
 */
export function describeJobError(error: unknown): string {
  if (isRedisAuthError(error)) return REDIS_AUTH_ERROR_TEXT;
  // A network error's message names the host and port ("connect ECONNREFUSED 10.0.0.5:6379"):
  // keep only the system call and the error code, which say what went wrong.
  const code = systemErrorCode(error);
  if (code) {
    const syscall = (error as { syscall?: unknown }).syscall;
    return `${(error as Error).name}: ${typeof syscall === 'string' ? `${syscall} ` : ''}${code}`;
  }
  const message = error instanceof Error ? `${error.name}: ${error.message}` : 'Unknown error';
  return redactRedisUrl(message);
}

/**
 * A short-lived Redis client that fails fast instead of retrying: for health checks. The caller
 * connects it and must `disconnect()` it.
 */
export function createProbeClient(): Redis {
  const client = new Redis(redisUrl(), {
    lazyConnect: true,
    connectTimeout: 2_000,
    maxRetriesPerRequest: 0,
    enableOfflineQueue: false,
    retryStrategy: () => null,
  });
  // Errors surface through the awaited commands; don't let the emitter throw.
  client.on('error', () => undefined);
  return client;
}
