import {
  addDays,
  BUSINESS_TIME_ZONE,
  type BusinessDate,
  DISPLAY_LOCALE,
  startOfBusinessDate,
  toBusinessDate,
} from '@pulse/core';

// Spec: docs/modules/core.md#home (decision 150 in docs/BUILD_PLAN.md) — the Home hero and tiles'
// pure helpers: the greeting by the Manila time of day, the Manila date, how many days ago the
// oldest waiting approval was submitted, and the window of upcoming holidays. Pure code, so it is
// tested without a database (lib/home.test.ts).

/** "Good morning" before 12:00, "Good afternoon" from 12:00 to 17:59, "Good evening" from 18:00. */
export type Greeting = 'Good morning' | 'Good afternoon' | 'Good evening';

const manilaHour = new Intl.DateTimeFormat('en-US', {
  timeZone: BUSINESS_TIME_ZONE,
  hourCycle: 'h23',
  hour: '2-digit',
});

/** The hour (0 to 23) in Manila at `instant`. */
export function manilaHourOf(instant: Date): number {
  const hour = manilaHour.formatToParts(instant).find((part) => part.type === 'hour');
  return Number(hour?.value ?? 0) % 24;
}

/** The greeting for the Manila time of day at `instant`. */
export function greetingFor(instant: Date): Greeting {
  const hour = manilaHourOf(instant);
  if (hour < 12) return 'Good morning';
  if (hour < 18) return 'Good afternoon';
  return 'Good evening';
}

/**
 * The hero's greeting: "Good morning, Ana", or without a name when there is none (the bootstrap
 * system account, which has no employee record).
 */
export function homeGreeting(instant: Date, firstName: string | null | undefined): string {
  const greeting = greetingFor(instant);
  const name = firstName?.trim();
  return name ? `${greeting}, ${name}` : greeting;
}

const heroDate = new Intl.DateTimeFormat(DISPLAY_LOCALE, {
  timeZone: BUSINESS_TIME_ZONE,
  weekday: 'long',
  month: 'long',
  day: 'numeric',
  year: 'numeric',
});

/** The hero's Manila date, for example "Monday, 12 October 2026" (in the display locale). */
export function formatHeroDate(instant: Date): string {
  return heroDate.format(instant);
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Whole Manila calendar days from `instant` to `reference` (0 on the same Manila day). */
export function manilaDaysBetween(instant: Date, reference: Date): number {
  const days = Math.round(
    (startOfBusinessDate(toBusinessDate(reference)).getTime() -
      startOfBusinessDate(toBusinessDate(instant)).getTime()) /
      DAY_MS,
  );
  return Math.max(0, days);
}

/**
 * The Approvals tile's line under the count: "Oldest submitted N days ago", from the oldest
 * waiting request's submit date, in Manila calendar days ("today" and "1 day ago" read naturally).
 */
export function oldestSubmittedLabel(submittedAt: Date, reference: Date): string {
  const days = manilaDaysBetween(submittedAt, reference);
  if (days === 0) return 'Oldest submitted today';
  return `Oldest submitted ${days} ${days === 1 ? 'day' : 'days'} ago`;
}

/** How far ahead the Upcoming holidays tile looks, in days, and how many it shows. */
export const UPCOMING_HOLIDAY_DAYS = 60;
export const UPCOMING_HOLIDAY_LIMIT = 3;

/** The Upcoming holidays window: today through the 60th day after it, both Manila days. */
export function upcomingHolidayWindow(today: BusinessDate): {
  from: BusinessDate;
  to: BusinessDate;
} {
  return { from: today, to: addDays(today, UPCOMING_HOLIDAY_DAYS) };
}

const holidayDate = new Intl.DateTimeFormat(DISPLAY_LOCALE, {
  timeZone: BUSINESS_TIME_ZONE,
  weekday: 'short',
  month: 'short',
  day: 'numeric',
});

/** A holiday's date on the tile, for example "Sun, 1 Nov" (in the display locale). */
export function formatHolidayDate(date: BusinessDate): string {
  return holidayDate.format(startOfBusinessDate(date));
}
