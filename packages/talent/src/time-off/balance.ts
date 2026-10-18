import type { BusinessDate, EmploymentStatus } from '@pulse/core';
import type { TimeOffRequestDay } from './days';
import type { LeaveEntryKind } from './kinds';
import type { LeaveType } from './settings';
import { halfDaysOf } from './units';

// Spec: docs/modules/talent.md#leave-offset-time-off-and-opening-balances-build-step-28 ("Leave
// entries", "Crediting", "Insufficient balance", "The holidays-changed listener"; decisions 303–305,
// 311 and 316 in docs/BUILD_PLAN.md) — leave balances from entries, the available balance, the
// paid and unpaid split, the regularization proration, the January 1 carry-over and credit, and
// the listener's reconcile of an approved request. Whole half days only, never stored.

/** What the sums read from a leave entry. */
export interface LeaveEntryHalfDays {
  kind: LeaveEntryKind;
  halfDays: number;
  effectiveOn: BusinessDate;
}

function assertWhole(value: number, what = 'Half days'): void {
  if (!Number.isSafeInteger(value)) throw new RangeError(`${what} must be a whole number.`);
}

/**
 * Throws when a leave entry's half days don't fit its kind: an opening is 0 or more, a credit
 * above 0, a carry-over 0 or less; usage and adjustments are signed.
 */
export function assertLeaveEntryHalfDays(kind: LeaveEntryKind, halfDays: number): void {
  assertWhole(halfDays);
  if (kind === 'opening' && halfDays < 0) throw new RangeError('An opening is 0 or more.');
  if (kind === 'credit' && halfDays <= 0) throw new RangeError('A credit is above 0.');
  if (kind === 'carryOver' && halfDays > 0) throw new RangeError('A carry-over is 0 or less.');
}

/** A type's balance: the sum of every entry. It may be below zero. */
export function leaveBalanceHalfDays(
  entries: Iterable<Pick<LeaveEntryHalfDays, 'halfDays'>>,
): number {
  let total = 0;
  for (const entry of entries) {
    assertWhole(entry.halfDays);
    total += entry.halfDays;
  }
  return total;
}

/**
 * The balance at the end of `day`: the entries dated on or before it. The carry-over reads the
 * day before the credit date.
 */
export function leaveBalanceOn(
  entries: Iterable<Pick<LeaveEntryHalfDays, 'halfDays' | 'effectiveOn'>>,
  day: BusinessDate,
): number {
  let total = 0;
  for (const entry of entries) {
    if (entry.effectiveOn > day) continue;
    assertWhole(entry.halfDays);
    total += entry.halfDays;
  }
  return total;
}

/**
 * The available balance (*Assumption*, item 159): the balance, never counting a credit or
 * carry-over dated after today, less the paid half days of the employee's other pending requests
 * of the type.
 */
export function availableLeaveHalfDays(input: {
  entries: Iterable<LeaveEntryHalfDays>;
  today: BusinessDate;
  pendingPaidHalfDays: Iterable<number>;
}): number {
  let total = 0;
  for (const entry of input.entries) {
    assertWhole(entry.halfDays);
    if ((entry.kind === 'credit' || entry.kind === 'carryOver') && entry.effectiveOn > input.today)
      continue;
    total += entry.halfDays;
  }
  for (const pending of input.pendingPaidHalfDays) {
    assertWhole(pending);
    total -= pending;
  }
  return total;
}

// ---------------------------------------------------------------------------------------------
// The paid and unpaid split

/** A request's half days: chargeable, and for a `credited` type its paid and unpaid ones. */
export interface LeaveSplit {
  chargeableHalfDays: number;
  /** Null for a type that isn't `credited`. */
  paidHalfDays: number | null;
  unpaidHalfDays: number | null;
}

/**
 * Marks each day paid or unpaid and returns the split. A `credited` type pays up to the available
 * balance from the first day; the rest is leave without pay from the last day back (*Assumption*,
 * item 159), so a day may be half paid. Any other type is all paid, or all unpaid when the type
 * isn't paid.
 */
export function splitLeaveDays(
  days: readonly TimeOffRequestDay[],
  type: Pick<LeaveType, 'balance' | 'paid'>,
  availableHalfDays: number,
): { days: TimeOffRequestDay[]; split: LeaveSplit } {
  assertWhole(availableHalfDays);
  const credited = type.balance === 'credited';
  let left = credited ? Math.max(0, availableHalfDays) : type.paid ? Infinity : 0;
  let chargeable = 0;
  let paid = 0;
  const out = days.map((day) => {
    chargeable += day.halfDays;
    const dayPaid = Math.min(day.halfDays, left);
    left -= dayPaid;
    paid += dayPaid;
    return { ...day, paidHalfDays: dayPaid, unpaidHalfDays: day.halfDays - dayPaid };
  });
  return {
    days: out,
    split: {
      chargeableHalfDays: chargeable,
      paidHalfDays: credited ? paid : null,
      unpaidHalfDays: credited ? chargeable - paid : null,
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Crediting

/**
 * The months of the regularization year a prorated credit counts: from the regularization month
 * to December, the regularization month only when the date is on or before the 15th.
 */
export function regularizationCreditMonths(regularizationDate: BusinessDate): number {
  const month = Number(regularizationDate.slice(5, 7));
  const day = Number(regularizationDate.slice(8, 10));
  return 12 - month + (day <= 15 ? 1 : 0);
}

/**
 * The credit at regularization, in half days: `days × months ÷ 12`, rounded to the nearest half
 * day, halves up (*Assumption*, item 150); the full `days` without proration. April 10 with 5
 * days: 9 months, 3.75 → 8 (4.0 days); April 20: 8 months, 3.33 → 7 (3.5 days).
 */
export function regularizationCreditHalfDays(
  type: Pick<LeaveType, 'days' | 'crediting'>,
  regularizationDate: BusinessDate,
): number {
  const full = halfDaysOf(type.days);
  if (!type.crediting?.prorateFromRegularization) return full;
  const months = regularizationCreditMonths(regularizationDate);
  // halfDays × months ÷ 12, half up: floor((x + 6) ÷ 12).
  return Math.floor((full * months + 6) / 12);
}

/**
 * The carry-over on the credit date: minus whatever the balance at the end of the day before
 * exceeds the cap by, or 0 with no cap or a balance within it (L12).
 */
export function carryOverHalfDays(
  type: Pick<LeaveType, 'crediting'>,
  balanceBeforeHalfDays: number,
): number {
  assertWhole(balanceBeforeHalfDays);
  const cap = type.crediting?.carryOverCapDays ?? null;
  if (cap === null) return 0;
  const excess = balanceBeforeHalfDays - halfDaysOf(cap);
  return excess > 0 ? -excess : 0;
}

/** The facts the credit job reads for one employee and one `credited` type. */
export interface LeaveCreditFacts {
  today: BusinessDate;
  /** `talent.leaveSettings.goLiveDate` on the credit date; nothing is written while it is null. */
  goLiveDate: BusinessDate | null;
  type: Pick<LeaveType, 'balance' | 'active' | 'days' | 'crediting'>;
  employmentStatus: EmploymentStatus;
  regularizationDate: BusinessDate | null;
  /** True for an active account; a separated employee gets nothing. */
  active: boolean;
}

/** A credit or carry-over entry the job writes (once per employee, type, kind and year). */
export interface PlannedLeaveEntry {
  kind: 'credit' | 'carryOver';
  year: number;
  effectiveOn: BusinessDate;
  /** For a carry-over, call `carryOverHalfDays` with the balance at the end of the day before. */
  halfDays: number | null;
}

/** The credit date of `year` for a type's `annualCreditOn` (`MM-DD`; Feb 29 is Feb 28 off leap years). */
export function annualCreditDate(annualCreditOn: string, year: number): BusinessDate {
  let monthDay = annualCreditOn;
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  if (monthDay === '02-29' && !leap) monthDay = '02-28';
  return `${String(year).padStart(4, '0')}-${monthDay}`;
}

/**
 * The entries the credit job writes today for one employee and type, in order (decision 304);
 * the unique index skips any already written. Only the current year: a Regular employee
 * regularized this year gets the regularization credit, dated the regularization date; one
 * regularized earlier gets, once the annual credit date has come, the carry-over and then the full
 * credit, both dated that day. Nothing before the go-live date, while it is null, for a retired
 * type, an inactive account, or anyone not Regular with a regularization date on or before today.
 */
export function plannedLeaveCredits(facts: LeaveCreditFacts): PlannedLeaveEntry[] {
  const { today, goLiveDate, type, regularizationDate } = facts;
  if (goLiveDate === null || !facts.active || !type.active) return [];
  if (type.balance !== 'credited' || !type.crediting) return [];
  if (facts.employmentStatus !== 'Regular' || !regularizationDate) return [];
  if (regularizationDate > today) return [];
  const year = Number(today.slice(0, 4));
  const regularizationYear = Number(regularizationDate.slice(0, 4));
  if (regularizationYear === year) {
    if (regularizationDate < goLiveDate) return [];
    return [
      {
        kind: 'credit',
        year,
        effectiveOn: regularizationDate,
        halfDays: regularizationCreditHalfDays(type, regularizationDate),
      },
    ];
  }
  const creditOn = annualCreditDate(type.crediting.annualCreditOn, year);
  if (creditOn > today || creditOn < goLiveDate) return [];
  return [
    { kind: 'carryOver', year, effectiveOn: creditOn, halfDays: null },
    { kind: 'credit', year, effectiveOn: creditOn, halfDays: halfDaysOf(type.days) },
  ];
}

// ---------------------------------------------------------------------------------------------
// The holidays-changed listener

/** An approved leave's stored split. */
export interface StoredLeaveSplit {
  chargeableHalfDays: number;
  paidHalfDays: number | null;
  unpaidHalfDays: number | null;
}

/**
 * The reconcile of an approved leave after a holiday change (decision 316). A fall gives back
 * from the unpaid days first, then the paid ones; a rise is paid from the available balance and
 * the rest unpaid. `balanceChangeHalfDays` is the `adjustment` to write (positive gives back), 0
 * when nothing changes, so a second run writes nothing. A type that isn't `credited` only changes
 * its chargeable days.
 */
export function reconcileLeaveSplit(
  stored: StoredLeaveSplit,
  newChargeableHalfDays: number,
  availableHalfDays: number,
): { split: StoredLeaveSplit; balanceChangeHalfDays: number } {
  assertWhole(newChargeableHalfDays);
  assertWhole(availableHalfDays);
  const difference = newChargeableHalfDays - stored.chargeableHalfDays;
  if (stored.paidHalfDays === null || stored.unpaidHalfDays === null) {
    return {
      split: {
        chargeableHalfDays: newChargeableHalfDays,
        paidHalfDays: null,
        unpaidHalfDays: null,
      },
      balanceChangeHalfDays: 0,
    };
  }
  let paid = stored.paidHalfDays;
  let unpaid = stored.unpaidHalfDays;
  if (difference < 0) {
    const fall = -difference;
    const fromUnpaid = Math.min(unpaid, fall);
    unpaid -= fromUnpaid;
    paid -= fall - fromUnpaid;
  } else if (difference > 0) {
    const fromBalance = Math.min(Math.max(0, availableHalfDays), difference);
    paid += fromBalance;
    unpaid += difference - fromBalance;
  }
  return {
    split: {
      chargeableHalfDays: newChargeableHalfDays,
      paidHalfDays: paid,
      unpaidHalfDays: unpaid,
    },
    balanceChangeHalfDays: stored.paidHalfDays - paid,
  };
}

/**
 * The offset reconcile of an approved offset time off: the `usage` entry's minutes to write
 * (positive gives back), charged even below zero when they rise (*Assumption*, item 167).
 */
export function reconcileOffsetMinutes(storedMinutes: number, newMinutes: number): number {
  assertWhole(storedMinutes, 'Minutes');
  assertWhole(newMinutes, 'Minutes');
  return storedMinutes - newMinutes;
}
