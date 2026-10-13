import {
  BUSINESS_TIME_ZONE,
  type BusinessDate,
  DISPLAY_LOCALE,
  startOfBusinessDate,
} from '@pulse/core';
import { epochMinuteOf, manilaDateOf, manilaDayStartMinute } from '@pulse/talent';

// Spec: docs/modules/talent.md#work-schedules-and-daily-time-entries-build-step-24 ("Screens") —
// the timesheet's display helpers, in Manila time. Hours come from `formatHours` in
// `@pulse/talent`; these only format dates and clock times.

const rangeFormat = new Intl.DateTimeFormat(DISPLAY_LOCALE, {
  timeZone: BUSINESS_TIME_ZONE,
  month: 'short',
  day: 'numeric',
  year: 'numeric',
});

const dayFormat = new Intl.DateTimeFormat(DISPLAY_LOCALE, {
  timeZone: BUSINESS_TIME_ZONE,
  weekday: 'long',
  month: 'long',
  day: 'numeric',
});

const shortDayFormat = new Intl.DateTimeFormat(DISPLAY_LOCALE, {
  timeZone: BUSINESS_TIME_ZONE,
  weekday: 'short',
  month: 'short',
  day: 'numeric',
});

/** "Sep 11 – 25, 2026", or "Sep 26 – Oct 10, 2026". */
export function cutOffRangeText(start: BusinessDate, end: BusinessDate): string {
  return rangeFormat.formatRange(startOfBusinessDate(start), startOfBusinessDate(end));
}

/** "Friday, September 11": the day sheet's title. */
export function longDayText(date: BusinessDate): string {
  return dayFormat.format(startOfBusinessDate(date));
}

/** "Fri, Sep 11": a folded run of rest days. */
export function shortDayText(date: BusinessDate): string {
  return shortDayFormat.format(startOfBusinessDate(date));
}

/** The day of the month of a business date ("2026-09-11" → 11). */
export function dayOfMonth(date: BusinessDate): number {
  return Number(date.slice(8, 10));
}

/** An instant as `HH:MM` on its Manila day, for a native time input. */
export function clockTimeOf(instant: Date): string {
  const minutes = epochMinuteOf(instant) - manilaDayStartMinute(manilaDateOf(instant));
  const hours = Math.floor(minutes / 60);
  return `${String(hours).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
}
