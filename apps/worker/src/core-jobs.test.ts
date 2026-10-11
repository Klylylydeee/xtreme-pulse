import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  HOLIDAY_AUTO_DRAFT_JOB,
  HOLIDAY_REMINDER_JOB,
  HOLIDAYS_CHANGED_JOB,
  runHolidayReminder,
  runHolidaysChangedListeners,
  runScheduledHolidayAutoDraft,
  SCHEDULE_TIME_ZONE,
} from '@pulse/core/server';
import type { JobContext, JobHandler } from '@pulse/core/server/worker';
import { coreJobHandlers, coreJobSchedules } from './core-jobs';
import { jobHandlers, jobSchedules } from './jobs';

// The worker's Core job wiring (docs/ARCHITECTURE.md#background-jobs): every Core job has a
// handler, the schedules are the documented ones, and each handler calls its Core service. The
// services themselves are tested in packages/core; here they are replaced with stubs.

vi.mock('@pulse/core/server', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@pulse/core/server')>();
  return {
    ...actual,
    runScheduledHolidayAutoDraft: vi.fn(async () => ({ stub: 'autoDraft' })),
    runHolidayReminder: vi.fn(async () => ({ stub: 'reminder' })),
    runHolidaysChangedListeners: vi.fn(async () => ({ listeners: 0 })),
  };
});

const context: JobContext = { jobId: 'test-1', attempt: 1, attempts: 5 };

function handlerFor(name: string): JobHandler {
  const handler = coreJobHandlers.find((candidate) => candidate.job.name === name);
  if (!handler) throw new Error(`No handler for "${name}".`);
  return handler;
}

beforeEach(() => {
  vi.mocked(runScheduledHolidayAutoDraft).mockClear();
  vi.mocked(runHolidayReminder).mockClear();
  vi.mocked(runHolidaysChangedListeners).mockClear();
});

describe('Core job registration', () => {
  it('has one handler per job, holiday jobs included', () => {
    const names = coreJobHandlers.map((handler) => handler.job.name);
    expect(new Set(names).size).toBe(names.length);
    expect(names).toEqual(
      expect.arrayContaining([
        'core.companyDetailsReminder',
        'core.accessReminder',
        'core.holidayAutoDraft',
        'core.holidayReminder',
        'core.holidaysChanged',
      ]),
    );
  });

  it('registers the Core handlers and schedules in production and development', () => {
    for (const production of [true, false]) {
      const names = jobHandlers({ production }).map((handler) => handler.job.name);
      expect(names).toEqual(
        expect.arrayContaining([
          'core.holidayAutoDraft',
          'core.holidayReminder',
          'core.holidaysChanged',
        ]),
      );
      const ids = jobSchedules({ production }).map((schedule) => schedule.id);
      expect(ids).toEqual(
        expect.arrayContaining([
          'core.holidayAutoDraft',
          'core.holidayReminderDecember',
          'core.holidayReminderJanuaryFebruary',
        ]),
      );
    }
  });

  it('gives every schedule a handler and a unique id', () => {
    for (const production of [true, false]) {
      const handled = new Set(jobHandlers({ production }).map((handler) => handler.job.name));
      const schedules = jobSchedules({ production });
      const ids = schedules.map((schedule) => schedule.id);
      expect(new Set(ids).size).toBe(ids.length);
      for (const schedule of schedules) expect(handled.has(schedule.job.name)).toBe(true);
    }
  });
});

describe('Holiday schedules', () => {
  it('runs on Manila time', () => {
    expect(SCHEDULE_TIME_ZONE).toBe('Asia/Manila');
  });

  it('drafts next year every October 1 at 8:00 AM', () => {
    const schedule = coreJobSchedules.find((candidate) => candidate.id === 'core.holidayAutoDraft');
    expect(schedule?.job).toBe(HOLIDAY_AUTO_DRAFT_JOB);
    expect(schedule?.pattern).toBe('0 8 1 10 *');
    expect(schedule?.data).toEqual({});
  });

  it('reminds in December and on Mondays in January and February at 8:00 AM', () => {
    const december = coreJobSchedules.find((s) => s.id === 'core.holidayReminderDecember');
    const januaryFebruary = coreJobSchedules.find(
      (s) => s.id === 'core.holidayReminderJanuaryFebruary',
    );
    expect(december?.job).toBe(HOLIDAY_REMINDER_JOB);
    expect(december?.pattern).toBe('0 8 1,8,15,22,29 12 *');
    expect(december?.data).toEqual({});
    expect(januaryFebruary?.job).toBe(HOLIDAY_REMINDER_JOB);
    expect(januaryFebruary?.pattern).toBe('0 8 * 1,2 1');
    expect(januaryFebruary?.data).toEqual({});
  });

  it('never schedules the holidays-changed job', () => {
    expect(coreJobSchedules.some((s) => s.job === HOLIDAYS_CHANGED_JOB)).toBe(false);
  });
});

describe('Holiday handlers', () => {
  it('runs the scheduled auto-draft', async () => {
    await expect(handlerFor('core.holidayAutoDraft').run({}, context)).resolves.toEqual({
      stub: 'autoDraft',
    });
    expect(runScheduledHolidayAutoDraft).toHaveBeenCalledTimes(1);
    expect(runScheduledHolidayAutoDraft).toHaveBeenCalledWith();
  });

  it('runs the reminder', async () => {
    await expect(handlerFor('core.holidayReminder').run({}, context)).resolves.toEqual({
      stub: 'reminder',
    });
    expect(runHolidayReminder).toHaveBeenCalledTimes(1);
    expect(runHolidayReminder).toHaveBeenCalledWith();
  });

  it('runs the holidays-changed listeners with the dates', async () => {
    const dates = ['2027-04-09', '2027-06-12'];
    await expect(handlerFor('core.holidaysChanged').run({ dates }, context)).resolves.toEqual({
      listeners: 0,
    });
    expect(runHolidaysChangedListeners).toHaveBeenCalledTimes(1);
    expect(runHolidaysChangedListeners).toHaveBeenCalledWith({ dates });
  });

  it('refuses holidays-changed data that does not match the schema', () => {
    const handler = handlerFor('core.holidaysChanged');
    for (const data of [{}, { dates: [] }, { dates: ['April 9'] }, null]) {
      expect(() => handler.run(data, context)).toThrow(/doesn't match its schema/);
    }
    expect(runHolidaysChangedListeners).not.toHaveBeenCalled();
  });
});
