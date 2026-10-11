import { z } from 'zod';
import { connectDb } from '@pulse/db';
import { type BusinessDate, now, toBusinessDate } from '../../dates';
import { activeHrAndSystemAdministrators } from '../auth/admin-recipients';
import { defineJob, defineSchedule } from '../jobs/define';
import { notify } from '../notifications/service';
import { HolidayModel } from './model';
import { HOLIDAYS_HREF } from './service';

// Spec: docs/modules/core.md#holiday-calendar and docs/ARCHITECTURE.md#background-jobs (decision
// 115 in docs/BUILD_PLAN.md) — the unconfirmed holidays reminder. The job `core.holidayReminder`
// notifies every active HR user and System Administrator (`core.holidaysUnconfirmed`, linking
// `/holidays`) while a year has no confirmed holiday:
//
// - December 1, 8, 15, 22 and 29 at 08:00 Asia/Manila, for next year;
// - every Monday at 08:00 in January and February, for the then-current year.
//
// Two schedules run the same job; the handler works out from the Manila date which year (if any)
// it is for, so a run on any other day sends nothing. Each recipient gets it at most once per year
// per Manila day, through `notify()`'s duplicate check (key
// `core.holidayReminder:<year>:<Manila date>`). Nothing is sent once that year has a confirmed
// holiday. It has no actor.

/** The notification event. */
export const HOLIDAYS_UNCONFIRMED_EVENT = 'core.holidaysUnconfirmed';

/** The job: no data, everything is read when it runs. */
export const HOLIDAY_REMINDER_JOB = defineJob('core.holidayReminder', { schema: z.object({}) });

/** December 1, 8, 15, 22 and 29 at 8:00 AM Manila (for next year). */
export const HOLIDAY_REMINDER_DECEMBER_SCHEDULE = defineSchedule({
  id: 'core.holidayReminderDecember',
  job: HOLIDAY_REMINDER_JOB,
  data: {},
  pattern: '0 8 1,8,15,22,29 12 *',
});

/** Mondays at 8:00 AM Manila in January and February (for the current year). */
export const HOLIDAY_REMINDER_JANUARY_FEBRUARY_SCHEDULE = defineSchedule({
  id: 'core.holidayReminderJanuaryFebruary',
  job: HOLIDAY_REMINDER_JOB,
  data: {},
  pattern: '0 8 * 1,2 1',
});

/** Both reminder schedules, for the worker's schedule list. */
export const HOLIDAY_REMINDER_SCHEDULES = [
  HOLIDAY_REMINDER_DECEMBER_SCHEDULE,
  HOLIDAY_REMINDER_JANUARY_FEBRUARY_SCHEDULE,
] as const;

const DECEMBER_DAYS = new Set([1, 8, 15, 22, 29]);
const MONDAY = 1;

/**
 * The year the reminder is for on the Manila day of `at`: next year on December 1, 8, 15, 22 and
 * 29, the current year on a Monday in January or February, otherwise null (no reminder that day).
 */
export function holidayReminderYear(at: Date): number | null {
  const today = toBusinessDate(at);
  const [year, month, day] = today.split('-').map(Number) as [number, number, number];
  if (month === 12 && DECEMBER_DAYS.has(day)) return year + 1;
  if (month === 1 || month === 2) {
    const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
    if (weekday === MONDAY) return year;
  }
  return null;
}

/** The duplicate check's key: `core.holidayReminder:<year>:<Manila date>`. */
export function holidayReminderKey(year: number, day: BusinessDate): string {
  return `core.holidayReminder:${year}:${day}`;
}

export interface HolidayReminderResult {
  /** The year it checked, or null when the day isn't a reminder day. */
  year: number | null;
  /** True when that year already has a confirmed holiday (nothing is sent). */
  confirmed: boolean;
  /** Notifications written in this run. */
  notified: number;
  /** Recipients skipped because they already got it for that year that Manila day. */
  skipped: number;
}

/**
 * Sends the unconfirmed holidays reminder for the Manila day of `at`, if that day is a reminder
 * day and its year has no confirmed holiday. Safe to run again the same day.
 */
export async function runHolidayReminder(at: Date = now()): Promise<HolidayReminderResult> {
  const year = holidayReminderYear(at);
  if (year === null) return { year: null, confirmed: false, notified: 0, skipped: 0 };

  await connectDb();
  const confirmed = await HolidayModel.exists({ year, status: 'confirmed' });
  if (confirmed) return { year, confirmed: true, notified: 0, skipped: 0 };

  const recipients = await activeHrAndSystemAdministrators();
  const notified = await notify({
    recipients: recipients.map((recipient) => recipient.id),
    module: 'core',
    event: HOLIDAYS_UNCONFIRMED_EVENT,
    title: `${year} holidays aren’t confirmed yet`,
    body: `Check the ${year} drafts against the Presidential Proclamation, enter each legal basis and confirm them.`,
    href: HOLIDAYS_HREF,
    dedupeKey: holidayReminderKey(year, toBusinessDate(at)),
  });
  return { year, confirmed: false, notified, skipped: recipients.length - notified };
}
