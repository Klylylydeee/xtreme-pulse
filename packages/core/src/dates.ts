import { DISPLAY_LOCALE } from './locale';

// Spec: docs/DATA_MODEL.md#general — store dates in UTC; display in Asia/Manila.
//
// Two kinds of value:
// - An instant (`Date`): a moment in time, stored in MongoDB as UTC.
// - A business date (`BusinessDate`, `"YYYY-MM-DD"`): a calendar day in Manila, for things like
//   effective dates, cut-offs, holidays and leave days. Its start is 00:00 Manila time.
// Module code gets "now" and "today" from these helpers, not from `new Date()`
// (docs/CODE_STYLE.md#money-and-dates).

/** The business time zone. Every business date, display and schedule uses it. */
export const BUSINESS_TIME_ZONE = 'Asia/Manila';

/** A calendar day in Manila, `"YYYY-MM-DD"`. */
export type BusinessDate = string;

/** Thrown for an invalid Date or business date. */
export class DateError extends RangeError {
  constructor(message: string) {
    super(message);
    this.name = 'DateError';
  }
}

const BUSINESS_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

function assertInstant(instant: Date): Date {
  if (!(instant instanceof Date) || Number.isNaN(instant.getTime())) {
    throw new DateError('Invalid date.');
  }
  return instant;
}

function parts(value: BusinessDate): { year: number; month: number; day: number } {
  const match = BUSINESS_DATE.exec(value);
  if (match) {
    const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
    // Round-trip through UTC to reject days like 2026-02-30.
    const check = new Date(Date.UTC(year, month - 1, day));
    if (
      year >= 1000 &&
      check.getUTCFullYear() === year &&
      check.getUTCMonth() === month - 1 &&
      check.getUTCDate() === day
    ) {
      return { year, month, day };
    }
  }
  throw new DateError(`"${value}" is not a date in YYYY-MM-DD form.`);
}

/** True when `value` is a real calendar day written `"YYYY-MM-DD"`. */
export function isBusinessDate(value: unknown): value is BusinessDate {
  if (typeof value !== 'string') return false;
  try {
    parts(value);
    return true;
  } catch {
    return false;
  }
}

/** Throws {@link DateError} unless `value` is a valid business date. */
export function assertBusinessDate(value: string): BusinessDate {
  parts(value);
  return value;
}

const manilaParts = new Intl.DateTimeFormat('en-US', {
  timeZone: BUSINESS_TIME_ZONE,
  hourCycle: 'h23',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
});

function wallClock(instant: Date): Record<string, number> {
  const out: Record<string, number> = {};
  for (const part of manilaParts.formatToParts(instant)) {
    if (part.type !== 'literal') out[part.type] = Number(part.value);
  }
  return out;
}

/** Manila's offset from UTC at `instant`, in milliseconds (+08:00 today; read from the tz data). */
function offsetMs(instant: Date): number {
  const w = wallClock(instant);
  const asUtc = Date.UTC(
    w.year ?? 0,
    (w.month ?? 1) - 1,
    w.day ?? 1,
    w.hour ?? 0,
    w.minute ?? 0,
    w.second ?? 0,
  );
  return asUtc - Math.floor(instant.getTime() / 1000) * 1000;
}

/** The Manila calendar day that `instant` falls on. */
export function toBusinessDate(instant: Date): BusinessDate {
  const w = wallClock(assertInstant(instant));
  const pad = (n: number | undefined, width: number) => String(n ?? 0).padStart(width, '0');
  return `${pad(w.year, 4)}-${pad(w.month, 2)}-${pad(w.day, 2)}`;
}

/** The Manila calendar year that `instant` falls on (document numbers use it). */
export function businessYear(instant: Date): number {
  return Number(toBusinessDate(instant).slice(0, 4));
}

/** The UTC instant at which a business date starts: 00:00 in Manila. */
export function startOfBusinessDate(date: BusinessDate): Date {
  const { year, month, day } = parts(date);
  const wall = Date.UTC(year, month - 1, day);
  // Two passes settle the offset even across an offset change.
  let guess = wall - offsetMs(new Date(wall));
  guess = wall - offsetMs(new Date(guess));
  return new Date(guess);
}

/**
 * The half-open UTC range `[start, end)` covering a business date in Manila. Query with
 * `{ $gte: start, $lt: end }`.
 */
export function businessDateRange(date: BusinessDate): { start: Date; end: Date } {
  return { start: startOfBusinessDate(date), end: startOfBusinessDate(addDays(date, 1)) };
}

/** Adds (or with a negative number, subtracts) calendar days. */
export function addDays(date: BusinessDate, days: number): BusinessDate {
  if (!Number.isSafeInteger(days)) throw new DateError('Days must be a whole number.');
  const { year, month, day } = parts(date);
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
}

/** Compares two business dates: negative, zero or positive. */
export function compareBusinessDates(a: BusinessDate, b: BusinessDate): number {
  assertBusinessDate(a);
  assertBusinessDate(b);
  return a < b ? -1 : a > b ? 1 : 0;
}

/** The current instant. Use this instead of `new Date()` in module code. */
export function now(): Date {
  return new Date();
}

/** Today's date in Manila. */
export function businessToday(): BusinessDate {
  return toBusinessDate(now());
}

// ---------------------------------------------------------------------------------------------
// Display (always in Manila time)

const dateFormat = new Intl.DateTimeFormat(DISPLAY_LOCALE, {
  timeZone: BUSINESS_TIME_ZONE,
  dateStyle: 'medium',
});
const dateTimeFormat = new Intl.DateTimeFormat(DISPLAY_LOCALE, {
  timeZone: BUSINESS_TIME_ZONE,
  dateStyle: 'medium',
  timeStyle: 'short',
});
const timeFormat = new Intl.DateTimeFormat(DISPLAY_LOCALE, {
  timeZone: BUSINESS_TIME_ZONE,
  timeStyle: 'short',
});

function toInstant(value: Date | BusinessDate): Date {
  // A business date is shown as itself: format its start, which is that day in Manila.
  return typeof value === 'string' ? startOfBusinessDate(value) : assertInstant(value);
}

/** `"Sep 25, 2026"`, the Manila date of an instant, or a business date as written. */
export function formatDate(value: Date | BusinessDate): string {
  return dateFormat.format(toInstant(value));
}

/** `"Sep 25, 2026, 3:04 PM"` in Manila time. */
export function formatDateTime(instant: Date): string {
  return dateTimeFormat.format(assertInstant(instant));
}

/** `"3:04 PM"` in Manila time. */
export function formatTime(instant: Date): string {
  return timeFormat.format(assertInstant(instant));
}

const relativeFormat = new Intl.RelativeTimeFormat(DISPLAY_LOCALE, { numeric: 'auto' });
const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/**
 * How long ago an instant was, for lists such as notifications: `"Just now"`, `"5 minutes ago"`,
 * `"3 hours ago"` (same Manila day), `"yesterday"`, `"4 days ago"`, then the Manila date
 * (`"Sep 25, 2026"`) from a week back. `reference` is "now" (pass it to keep a list consistent).
 */
export function formatRelativeTime(instant: Date, reference: Date = now()): string {
  const then = assertInstant(instant);
  const at = assertInstant(reference);
  const elapsed = at.getTime() - then.getTime();
  if (elapsed < MINUTE_MS) return 'Just now';
  const days = Math.round(
    (startOfBusinessDate(toBusinessDate(at)).getTime() -
      startOfBusinessDate(toBusinessDate(then)).getTime()) /
      DAY_MS,
  );
  if (days === 0) {
    if (elapsed < HOUR_MS) return relativeFormat.format(-Math.floor(elapsed / MINUTE_MS), 'minute');
    return relativeFormat.format(-Math.floor(elapsed / HOUR_MS), 'hour');
  }
  if (days < 7) return relativeFormat.format(-days, 'day');
  return formatDate(then);
}
