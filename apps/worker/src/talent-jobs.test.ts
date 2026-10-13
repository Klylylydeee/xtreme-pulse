import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SCHEDULE_TIME_ZONE } from '@pulse/core/server';
import type { JobContext } from '@pulse/core/server/worker';
import {
  EXPIRY_ALERTS_JOB,
  OPEN_TIMESHEETS_JOB,
  runExpiryAlerts,
  runOpenTimesheets,
} from '@pulse/talent/server';
import { jobHandlers, jobSchedules } from './jobs';
import { talentJobHandlers, talentJobSchedules } from './talent-jobs';

// The worker's Talent job wiring (docs/ARCHITECTURE.md#background-jobs): the expiry alert job
// (build step 2.2) and the timesheet opening job (build step 2.4) each have one handler and one
// schedule on Manila time (`0 8 * * *` and `5 0 * * *`), and each handler calls Talent's service.
// The services themselves are tested in packages/talent; here they are stubs.

vi.mock('@pulse/talent/server', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@pulse/talent/server')>();
  return {
    ...actual,
    runExpiryAlerts: vi.fn(async () => ({ stub: 'expiryAlerts' })),
    runOpenTimesheets: vi.fn(async () => ({ stub: 'openTimesheets' })),
  };
});

const context: JobContext = { jobId: 'test-1', attempt: 1, attempts: 5 };

beforeEach(() => {
  vi.mocked(runExpiryAlerts).mockClear();
  vi.mocked(runOpenTimesheets).mockClear();
});

describe('Talent job registration', () => {
  it('registers the expiry alert handler and schedule in production and development', () => {
    for (const production of [true, false]) {
      const names = jobHandlers({ production }).map((handler) => handler.job.name);
      expect(names.filter((name) => name === 'talent.expiryAlerts')).toHaveLength(1);
      const ids = jobSchedules({ production }).map((schedule) => schedule.id);
      expect(ids).toContain('talent.expiryAlerts');
      expect(new Set(ids).size).toBe(ids.length);
    }
  });

  it('runs daily at 8:00 AM Manila', () => {
    expect(SCHEDULE_TIME_ZONE).toBe('Asia/Manila');
    const schedule = talentJobSchedules.find((s) => s.id === 'talent.expiryAlerts');
    expect(schedule?.job).toBe(EXPIRY_ALERTS_JOB);
    expect(schedule?.pattern).toBe('0 8 * * *');
    expect(schedule?.data).toEqual({});
  });

  it('runs the expiry alerts', async () => {
    const handler = talentJobHandlers.find((h) => h.job.name === 'talent.expiryAlerts');
    await expect(handler?.run({}, context)).resolves.toEqual({ stub: 'expiryAlerts' });
    expect(runExpiryAlerts).toHaveBeenCalledTimes(1);
    expect(runExpiryAlerts).toHaveBeenCalledWith();
  });
});

describe('Timesheet opening job registration (build step 2.4)', () => {
  it('registers the handler and schedule once, in production and development', () => {
    for (const production of [true, false]) {
      const names = jobHandlers({ production }).map((handler) => handler.job.name);
      expect(names.filter((name) => name === 'talent.openTimesheets')).toHaveLength(1);
      const ids = jobSchedules({ production }).map((schedule) => schedule.id);
      expect(ids.filter((id) => id === 'talent.openTimesheets')).toHaveLength(1);
    }
  });

  it('runs daily at 00:05 Manila', () => {
    expect(SCHEDULE_TIME_ZONE).toBe('Asia/Manila');
    const schedule = talentJobSchedules.find((s) => s.id === 'talent.openTimesheets');
    expect(schedule?.job).toBe(OPEN_TIMESHEETS_JOB);
    expect(schedule?.pattern).toBe('5 0 * * *');
    expect(schedule?.data).toEqual({});
  });

  it('opens the timesheets through Talent’s service', async () => {
    const handler = talentJobHandlers.find((h) => h.job.name === 'talent.openTimesheets');
    await expect(handler?.run({}, context)).resolves.toEqual({ stub: 'openTimesheets' });
    expect(runOpenTimesheets).toHaveBeenCalledTimes(1);
    expect(runOpenTimesheets).toHaveBeenCalledWith();
    expect(runExpiryAlerts).not.toHaveBeenCalled();
  });
});
