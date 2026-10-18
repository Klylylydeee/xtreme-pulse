import {
  BUSINESS_TIME_ZONE,
  type BusinessDate,
  DISPLAY_LOCALE,
  startOfBusinessDate,
} from '@pulse/core';
import {
  formatDayCount,
  formatOffsetHours,
  TIME_OFF_DAY_EXCLUSIONS,
  type TimeOffDayExclusion,
  type TimeOffRequestDay,
  type TimeOffRequestView,
} from '@pulse/talent';

// Spec: docs/modules/talent.md#leave-offset-time-off-and-opening-balances-build-step-28 ("Units
// and counting", "Screens") — the time off screens' display helpers, in Manila time. Days and
// hours come from `@pulse/talent` (`formatDayCount`, `formatOffsetHours`); these only add the
// date tile, the request's amount and the days a request leaves out.

const monthFormat = new Intl.DateTimeFormat(DISPLAY_LOCALE, {
  timeZone: BUSINESS_TIME_ZONE,
  month: 'short',
});

/** "Nov" for a business date: the date tile's top line. */
export function monthShortText(date: BusinessDate): string {
  return monthFormat.format(startOfBusinessDate(date));
}

/** A request's amount: "3 days", "0.5 day", "8.0 h"; null when it isn't known. */
export function requestAmountText(
  request: Pick<TimeOffRequestView, 'kind' | 'chargeableHalfDays' | 'minutes'>,
): string | null {
  if (request.kind === 'offset') {
    return request.minutes === null ? null : formatOffsetHours(request.minutes);
  }
  return request.chargeableHalfDays === null ? null : formatDayCount(request.chargeableHalfDays);
}

/** Why a day of a request doesn't count, as the summary names it. */
export const DAY_EXCLUSION_LABELS: Record<TimeOffDayExclusion, string> = {
  beforeHired: 'Before your date hired',
  afterSeparation: 'After the separation date',
  noSchedule: 'No work schedule',
  holiday: 'Holiday',
  restDay: 'Rest day',
};

/** The days a request leaves out, grouped by why: [["Rest day", ["2026-11-07", …]], …]. */
export function excludedDaysByReason(
  days: readonly TimeOffRequestDay[],
): [label: string, dates: BusinessDate[]][] {
  const groups: [string, BusinessDate[]][] = [];
  for (const reason of TIME_OFF_DAY_EXCLUSIONS) {
    const dates = days.filter((day) => day.excluded === reason).map((day) => day.date);
    if (dates.length > 0) groups.push([DAY_EXCLUSION_LABELS[reason], dates]);
  }
  return groups;
}
