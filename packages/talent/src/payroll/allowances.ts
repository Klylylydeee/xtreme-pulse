import type { BusinessDate, Centavos } from '@pulse/core';
import type { AllowanceBasis, AllowanceTaxTreatment, AllowanceType } from './schemas';

// Spec: docs/modules/talent.md#payroll-settings-and-allowances-build-step-23 and
// docs/DATA_MODEL.md#collection-ownership ("Allowances", decisions 202 and 203 in
// docs/BUILD_PLAN.md) — which allowances are in effect on a day. Pure code, safe in the browser.
//
// - For each type, the latest explicit entry with an effective date on or before the day wins
//   (the newest created on a tie); `end` means none.
// - An automatic type with no such entry applies from the date hired, at the default amount of the
//   `talent.allowanceTypes` version in effect that day. Nothing is stored for it.
// - Nothing applies before the date hired (*assumption*: the employee isn't employed yet).
// - An automatic type applies only while it is active in that day's version (*assumption*).

export const ALLOWANCE_ASSIGNMENT_KINDS = ['set', 'end'] as const;
export type AllowanceAssignmentKind = (typeof ALLOWANCE_ASSIGNMENT_KINDS)[number];

/** An explicit entry, as the rule reads it. `amountCentavos` is null for `end` (or when not loaded). */
export interface AllowanceEntryTimeline {
  id: string;
  typeKey: string;
  effectiveDate: BusinessDate;
  kind: AllowanceAssignmentKind;
  createdAt: Date;
  amountCentavos?: Centavos | null;
}

/** One allowance in effect on a day. */
export interface AllowanceInEffect {
  typeKey: string;
  /** The type's name in that day's version, or the key when the type is missing from it. */
  name: string;
  basis: AllowanceBasis | null;
  taxTreatment: AllowanceTaxTreatment | null;
  deMinimisKey: string | null;
  origin: 'automatic' | 'assigned';
  /**
   * The amount: the type's default for an automatic line; the entry's amount for an assigned one
   * (null when it wasn't loaded).
   */
  amountCentavos: Centavos | null;
  /** The date hired for an automatic line; the winning entry's effective date for an assigned one. */
  since: BusinessDate;
  /** The winning entry, for an assigned line. */
  entryId: string | null;
}

/** Newest first: by effective date, then creation time, then id. */
export function compareAllowanceEntries(
  a: AllowanceEntryTimeline,
  b: AllowanceEntryTimeline,
): number {
  if (a.effectiveDate !== b.effectiveDate) return a.effectiveDate < b.effectiveDate ? 1 : -1;
  const time = b.createdAt.getTime() - a.createdAt.getTime();
  if (time !== 0) return time;
  return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
}

/** The winning entry of each type on `day`, by type key (an `end` entry included). */
export function winningAllowanceEntries<T extends AllowanceEntryTimeline>(
  entries: readonly T[],
  day: BusinessDate,
): Map<string, T> {
  const winners = new Map<string, T>();
  for (const entry of [...entries].sort(compareAllowanceEntries)) {
    if (entry.effectiveDate > day || winners.has(entry.typeKey)) continue;
    winners.set(entry.typeKey, entry);
  }
  return winners;
}

/**
 * The allowances in effect on `day` for an employee hired on `dateHired`, from their explicit
 * entries and the `talent.allowanceTypes` types in effect that day (empty when none is).
 * Automatic lines first, in the types' order, then assigned types not in the version, by key.
 */
export function resolveAllowances({
  day,
  dateHired,
  types,
  entries,
}: {
  day: BusinessDate;
  dateHired: BusinessDate;
  types: readonly AllowanceType[];
  entries: readonly AllowanceEntryTimeline[];
}): AllowanceInEffect[] {
  if (day < dateHired) return [];
  const winners = winningAllowanceEntries(entries, day);
  const lines: AllowanceInEffect[] = [];
  const seen = new Set<string>();
  const line = (type: AllowanceType | undefined, typeKey: string) => ({
    typeKey,
    name: type?.name ?? typeKey,
    basis: type?.basis ?? null,
    taxTreatment: type?.taxTreatment ?? null,
    deMinimisKey: type?.deMinimisKey ?? null,
  });
  for (const type of types) {
    seen.add(type.key);
    const winner = winners.get(type.key);
    if (winner) {
      if (winner.kind === 'set') {
        lines.push({
          ...line(type, type.key),
          origin: 'assigned',
          amountCentavos: winner.amountCentavos ?? null,
          since: winner.effectiveDate,
          entryId: winner.id,
        });
      }
      continue;
    }
    if (type.autoAssign && type.active && type.basis === 'perCutOff') {
      lines.push({
        ...line(type, type.key),
        origin: 'automatic',
        amountCentavos: type.defaultAmountCentavos,
        since: dateHired,
        entryId: null,
      });
    }
  }
  // An entry for a type the day's version doesn't list (a version from before the type existed).
  for (const [typeKey, winner] of [...winners].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    if (seen.has(typeKey) || winner.kind !== 'set') continue;
    lines.push({
      ...line(undefined, typeKey),
      origin: 'assigned',
      amountCentavos: winner.amountCentavos ?? null,
      since: winner.effectiveDate,
      entryId: winner.id,
    });
  }
  return lines;
}

export const ALLOWANCE_ENTRY_STATUSES = ['current', 'scheduled', 'superseded', 'previous'] as const;
export type AllowanceEntryStatus = (typeof ALLOWANCE_ENTRY_STATUSES)[number];

/** Each explicit entry's status on `today`, by id (as compensation entries, per type). */
export function allowanceEntryStatuses(
  entries: readonly AllowanceEntryTimeline[],
  today: BusinessDate,
): Map<string, AllowanceEntryStatus> {
  const statuses = new Map<string, AllowanceEntryStatus>();
  const seenDates = new Set<string>();
  const currentFound = new Set<string>();
  for (const entry of [...entries].sort(compareAllowanceEntries)) {
    const dateKey = `${entry.typeKey}|${entry.effectiveDate}`;
    if (seenDates.has(dateKey)) {
      statuses.set(entry.id, 'superseded');
      continue;
    }
    seenDates.add(dateKey);
    if (entry.effectiveDate > today) statuses.set(entry.id, 'scheduled');
    else if (!currentFound.has(entry.typeKey)) {
      statuses.set(entry.id, 'current');
      currentFound.add(entry.typeKey);
    } else statuses.set(entry.id, 'previous');
  }
  return statuses;
}
