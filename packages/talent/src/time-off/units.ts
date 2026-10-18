import { formatHours } from '../timesheets/compute';

// Spec: docs/modules/talent.md#leave-offset-time-off-and-opening-balances-build-step-28 ("Units
// and counting"; decision 302 in docs/BUILD_PLAN.md) — leave is counted and stored in whole half
// days (2.5 days is 5), offset in whole minutes. Integer arithmetic only: a number of days typed
// or stored as text ("2.5") is parsed into half days, never into a floating-point number.

/** Half days in a day. */
export const HALF_DAYS_PER_DAY = 2;

/**
 * Days written as text: a whole number, or a whole number and a half ("5", "2.5", "0.5"; "5.0"
 * reads as 5). Stored settings hold days this way, since Core's store refuses fractional numbers.
 */
export const DAYS_TEXT_PATTERN = /^\d{1,4}(?:\.(?:0|5))?$/;

function assertWhole(value: number, what: string): void {
  if (!Number.isSafeInteger(value)) throw new RangeError(`${what} must be a whole number.`);
}

/** "2.5" → 5 half days; null when the text isn't a whole or half day. */
export function parseDaysText(text: string): number | null {
  const trimmed = text.trim();
  if (!DAYS_TEXT_PATTERN.test(trimmed)) return null;
  const [whole = '0', fraction = '0'] = trimmed.split('.');
  return Number(whole) * HALF_DAYS_PER_DAY + (fraction === '5' ? 1 : 0);
}

/** The half days of a stored days text; throws when it isn't one (the schema checks it first). */
export function halfDaysOf(daysText: string): number {
  const halfDays = parseDaysText(daysText);
  if (halfDays === null) throw new RangeError(`"${daysText}" is not a whole or half day.`);
  return halfDays;
}

/** Half days as the canonical days text: 5 → "2.5", 4 → "2" (negative: −3 → "-1.5"). */
export function daysTextOf(halfDays: number): string {
  assertWhole(halfDays, 'Half days');
  const sign = halfDays < 0 ? '-' : '';
  const abs = Math.abs(halfDays);
  const whole = Math.floor(abs / HALF_DAYS_PER_DAY);
  return `${sign}${whole}${abs % HALF_DAYS_PER_DAY === 1 ? '.5' : ''}`;
}

/** Half days with one decimal: 9 → "4.5", 8 → "4.0", −1 → "−0.5". */
export function halfDaysText(halfDays: number): string {
  assertWhole(halfDays, 'Half days');
  const abs = Math.abs(halfDays);
  const text = `${Math.floor(abs / HALF_DAYS_PER_DAY)}.${abs % HALF_DAYS_PER_DAY === 1 ? 5 : 0}`;
  return `${halfDays < 0 ? '−' : ''}${text}`;
}

/** A balance: "4.5 days", "1.0 day", "0.5 day", "−0.5 day", "0.0 days". */
export function formatLeaveDays(halfDays: number): string {
  const abs = Math.abs(halfDays);
  return `${halfDaysText(halfDays)} ${abs > 0 && abs <= HALF_DAYS_PER_DAY ? 'day' : 'days'}`;
}

/** A count of days in a sentence: "3 days", "1 day", "0.5 day", "2.5 days". */
export function formatDayCount(halfDays: number): string {
  assertWhole(halfDays, 'Half days');
  const abs = Math.abs(halfDays);
  const text = `${halfDays < 0 ? '−' : ''}${daysTextOf(abs)}`;
  return `${text} ${abs > 0 && abs <= HALF_DAYS_PER_DAY ? 'day' : 'days'}`;
}

/** Signed days for an adjustment: +2 → "+1.0 day", −3 → "−1.5 days". */
export function formatSignedLeaveDays(halfDays: number): string {
  if (halfDays === 0) return formatLeaveDays(0);
  return `${halfDays > 0 ? '+' : ''}${formatLeaveDays(halfDays)}`;
}

// ---------------------------------------------------------------------------------------------
// Offset hours typed by HR

/** Hours typed with up to two decimals ("1.25", "8", "0.5"); a leading "-" for an adjustment. */
export const HOURS_TEXT_PATTERN = /^-?\d{1,5}(?:\.\d{1,2})?$/;

/**
 * Hours typed with up to two decimals as whole minutes, rounded half up (away from zero for a
 * negative): "1.25" → 75, "0.01" → 1, "-0.5" → −30. Null when the text isn't such a number.
 */
export function minutesOfHoursText(text: string): number | null {
  const trimmed = text.trim();
  if (!HOURS_TEXT_PATTERN.test(trimmed)) return null;
  const negative = trimmed.startsWith('-');
  const [whole = '0', fraction = ''] = trimmed.replace('-', '').split('.');
  const hundredths = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  // minutes = hundredths × 60 ÷ 100 = hundredths × 3 ÷ 5; half up: floor((6h + 5) ÷ 10).
  const minutes = Math.floor((hundredths * 6 + 5) / 10);
  return negative ? -minutes : minutes;
}

/** Signed hours for display: 75 → "1.3 h", −30 → "−0.5 h". */
export function formatOffsetHours(minutes: number): string {
  assertWhole(minutes, 'Minutes');
  return `${minutes < 0 ? '−' : ''}${formatHours(Math.abs(minutes))}`;
}
