import { z } from 'zod';
import { businessDateField } from '../../validation';
import { defineJob, defineSchedule } from './define';

// Development-only jobs for `/dev/health` (build step 0.7). They show the worker running a job,
// retrying a failure, running a schedule on Manila time, and generating PDF and Excel files. The
// worker registers them only outside production.

/** Returns when it ran. Fails its first `failAttempts` tries on purpose, to show retries. */
export const DEV_PING_JOB = defineJob('dev.ping', {
  schema: z.object({
    failAttempts: z.number().int().min(0).max(3).default(0),
  }),
  attempts: 4,
  backoff: { type: 'fixed', delay: 500 },
});

/** Generates the sample PDF and Excel files for one day, once (idempotent). */
export const DEV_SAMPLE_EXPORTS_JOB = defineJob('dev.sampleExports', {
  schema: z.object({ day: businessDateField() }),
  attempts: 3,
  backoff: { type: 'fixed', delay: 1_000 },
});

/** A sample schedule: every day at 8:00 AM Manila time. */
export const DEV_DAILY_PING_SCHEDULE = defineSchedule({
  id: 'dev.dailyPing',
  job: DEV_PING_JOB,
  data: { failAttempts: 0 },
  pattern: '0 8 * * *',
});

/** The idempotency keys of one day's sample files. */
export function devSampleExportKeys(day: string): { pdf: string; xlsx: string } {
  return { pdf: `dev.sampleExports:${day}:pdf`, xlsx: `dev.sampleExports:${day}:xlsx` };
}
