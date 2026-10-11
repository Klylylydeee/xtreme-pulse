import { type BusinessDate, isBusinessDate } from '@pulse/core';

// Spec: docs/modules/talent.md#the-employee-record-build-step-21 and
// docs/DATA_MODEL.md#collection-ownership (decision 163 in docs/BUILD_PLAN.md) — compensation is
// effective-dated and append-only. Pure code, safe in the browser.
//
// - The current entry is the latest one whose effective date is today or earlier in Manila; on a
//   tie (a correction, same effective date), the latest created wins.
// - An entry with a later effective date is scheduled.
// - An entry another one with the same effective date replaced is superseded.
// - Any other earlier entry is previous.

export const COMPENSATION_STATUSES = ['current', 'scheduled', 'superseded', 'previous'] as const;
export type CompensationStatus = (typeof COMPENSATION_STATUSES)[number];
export const COMPENSATION_STATUS_LABELS: Record<CompensationStatus, string> = {
  current: 'Current',
  scheduled: 'Scheduled',
  superseded: 'Superseded',
  previous: 'Previous',
};

/** What the status rule reads from an entry. */
export interface CompensationTimeline {
  id: string;
  effectiveDate: BusinessDate;
  createdAt: Date;
}

/** Newest first: by effective date, then by creation time, then by id. */
export function compareCompensationEntries(a: CompensationTimeline, b: CompensationTimeline) {
  if (a.effectiveDate !== b.effectiveDate) return a.effectiveDate < b.effectiveDate ? 1 : -1;
  const time = b.createdAt.getTime() - a.createdAt.getTime();
  if (time !== 0) return time;
  return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
}

/** Each entry's status on `today` (a Manila day), by entry id. */
export function compensationStatuses(
  entries: readonly CompensationTimeline[],
  today: BusinessDate,
): Map<string, CompensationStatus> {
  const sorted = [...entries].sort(compareCompensationEntries);
  const statuses = new Map<string, CompensationStatus>();
  const seenDates = new Set<string>();
  let currentFound = false;
  for (const entry of sorted) {
    if (seenDates.has(entry.effectiveDate)) {
      statuses.set(entry.id, 'superseded');
      continue;
    }
    seenDates.add(entry.effectiveDate);
    if (entry.effectiveDate > today) {
      statuses.set(entry.id, 'scheduled');
    } else if (!currentFound) {
      statuses.set(entry.id, 'current');
      currentFound = true;
    } else {
      statuses.set(entry.id, 'previous');
    }
  }
  return statuses;
}

/** The current entry on `today`, or null when there is none yet. */
export function currentCompensationEntry<T extends CompensationTimeline>(
  entries: readonly T[],
  today: BusinessDate,
): T | null {
  const statuses = compensationStatuses(entries, today);
  return entries.find((entry) => statuses.get(entry.id) === 'current') ?? null;
}

/**
 * The latest effective date allowed on `today`: one year ahead, the same day of the year (February
 * 29 becomes February 28).
 */
export function latestEffectiveDate(today: BusinessDate): BusinessDate {
  const year = Number(today.slice(0, 4)) + 1;
  const sameDay = `${String(year).padStart(4, '0')}${today.slice(4)}`;
  return isBusinessDate(sameDay) ? sameDay : `${String(year).padStart(4, '0')}-02-28`;
}
