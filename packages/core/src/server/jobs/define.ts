import type { z } from 'zod';
import { BUSINESS_TIME_ZONE } from '../../dates';

// Job and schedule definitions. A definition (name, data schema, retries) is plain data that both
// the web app (to enqueue) and the worker (to run) import. The handler is registered only in the
// worker (`handleJob` in `@pulse/core/server/worker`), so the web app never loads job code.
//
// Jobs may run more than once: a retry after a crash or a timeout, or the same job enqueued twice.
// Every handler must be idempotent. Check for the result before creating it (an idempotency key or
// a unique index), the way `saveGeneratedFile` does with `idempotencyKey`.
//
// Job data is stored in Redis in plain text: never put sensitive fields (SECURITY.md#sensitive-data),
// passwords or secrets in it. Pass record ids and let the handler read the record.

/** Retry timing after a failed attempt. */
export type JobBackoff = { type: 'fixed' | 'exponential'; delay: number };

export interface JobDefinition<TSchema extends z.ZodType = z.ZodType> {
  /** `<module>.<name>`, for example `desk.slaTimer` or `insight.weeklyBoardSummary`. */
  readonly name: string;
  readonly schema: TSchema;
  /** Total tries, including the first. */
  readonly attempts: number;
  readonly backoff: JobBackoff;
}

/**
 * Default retries: 5 tries, 30 s, 1 min, 2 min and 4 min apart. The spec sets no retry policy
 * (docs/ARCHITECTURE.md#background-jobs); a job can set its own.
 */
export const DEFAULT_JOB_ATTEMPTS = 5;
export const DEFAULT_JOB_BACKOFF: JobBackoff = Object.freeze({
  type: 'exponential',
  delay: 30_000,
});

const JOB_NAME = /^[a-z][a-zA-Z0-9]*\.[a-z][a-zA-Z0-9]*$/;

/** Declares a job. Call once per job, in the module that owns it. */
export function defineJob<TSchema extends z.ZodType>(
  name: string,
  {
    schema,
    attempts = DEFAULT_JOB_ATTEMPTS,
    backoff = DEFAULT_JOB_BACKOFF,
  }: { schema: TSchema; attempts?: number; backoff?: JobBackoff },
): JobDefinition<TSchema> {
  if (!JOB_NAME.test(name)) {
    throw new Error(`"${name}" is not a job name. Use "<module>.<name>" in camelCase.`);
  }
  if (!Number.isSafeInteger(attempts) || attempts < 1) {
    throw new Error(`Job "${name}" needs at least 1 attempt.`);
  }
  return Object.freeze({ name, schema, attempts, backoff: Object.freeze({ ...backoff }) });
}

/** The time zone every schedule runs on (docs/ARCHITECTURE.md#background-jobs). */
export const SCHEDULE_TIME_ZONE = BUSINESS_TIME_ZONE;

export interface ScheduleDefinition<TSchema extends z.ZodType = z.ZodType> {
  /** Unique and stable: renaming it creates a new schedule. `<module>.<name>`. */
  readonly id: string;
  readonly job: JobDefinition<TSchema>;
  readonly data: z.input<TSchema>;
  /** A cron pattern, read on Asia/Manila time: `0 8 * * 1` is Mondays at 8:00 AM Manila. */
  readonly pattern: string;
}

/** Declares a scheduled job. The worker registers every schedule it is given when it starts. */
export function defineSchedule<TSchema extends z.ZodType>(
  schedule: ScheduleDefinition<TSchema>,
): ScheduleDefinition<TSchema> {
  if (!JOB_NAME.test(schedule.id)) {
    throw new Error(`"${schedule.id}" is not a schedule id. Use "<module>.<name>" in camelCase.`);
  }
  if (!schedule.job.schema.safeParse(schedule.data).success) {
    throw new Error(`The data for schedule "${schedule.id}" doesn't match its job's schema.`);
  }
  return Object.freeze({ ...schedule });
}
