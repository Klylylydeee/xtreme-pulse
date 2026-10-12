import type { BusinessDate, EmploymentStatus } from '@pulse/core';

// Spec: docs/modules/talent.md#the-employee-record-build-step-21 ("Derived, not stored") — values
// the record shows but never stores. Pure code, safe in the browser.

/** How long probation lasts from the date hired (docs/modules/talent.md#probation--contract-tracking). */
export const PROBATION_MONTHS = 6;

/** `date` plus whole calendar months; a day past the month's end becomes its last day. */
export function addMonths(date: BusinessDate, months: number): BusinessDate {
  const year = Number(date.slice(0, 4));
  const month = Number(date.slice(5, 7)) - 1 + months;
  const day = Number(date.slice(8, 10));
  const targetYear = year + Math.floor(month / 12);
  const targetMonth = ((month % 12) + 12) % 12;
  const lastDay = new Date(Date.UTC(targetYear, targetMonth + 1, 0)).getUTCDate();
  const pad = (n: number, width: number) => String(n).padStart(width, '0');
  return `${pad(targetYear, 4)}-${pad(targetMonth + 1, 2)}-${pad(Math.min(day, lastDay), 2)}`;
}

/** The date hired + 6 months while the status is Probationary, else null. */
export function probationEndDate(
  status: EmploymentStatus,
  dateHired: BusinessDate,
): BusinessDate | null {
  return status === 'Probationary' ? addMonths(dateHired, PROBATION_MONTHS) : null;
}

/** A Contractual employee with no contract end date shows "Contract end date missing". */
export function isContractEndDateMissing(
  status: EmploymentStatus,
  contractEndDate: BusinessDate | null,
): boolean {
  return status === 'Contractual' && contractEndDate === null;
}

// Step 2.2: expiry badges and the expiry alerts
// (docs/modules/talent.md#documents-photo-e-signature-and-certifications-build-step-22).

/** Whole calendar days from `from` to `to` (negative when `to` is earlier). */
export function daysBetween(from: BusinessDate, to: BusinessDate): number {
  const utc = (date: BusinessDate) =>
    Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10)));
  return Math.round((utc(to) - utc(from)) / 86_400_000);
}

/**
 * Where an expiry date stands on `today`:
 * - `none`: no expiry date
 * - `expired`: on or after the expiry date ("Expired")
 * - `expiring`: within `leadDays` of it ("Expires in N days")
 * - `valid`: further away ("Valid")
 */
export type ExpiryStatus = 'none' | 'valid' | 'expiring' | 'expired';

export interface ExpiryState {
  status: ExpiryStatus;
  /** Days from today to the expiry date (0 on the day, negative after); null without one. */
  daysLeft: number | null;
}

export function expiryStateOf(
  expiryDate: BusinessDate | null,
  today: BusinessDate,
  leadDays: number,
): ExpiryState {
  if (!expiryDate) return { status: 'none', daysLeft: null };
  const daysLeft = daysBetween(today, expiryDate);
  if (daysLeft <= 0) return { status: 'expired', daysLeft };
  return { status: daysLeft <= leadDays ? 'expiring' : 'valid', daysLeft };
}

/** The badge text ("Expired", "Expires in N days", "Valid"), or null without an expiry date. */
export function expiryBadgeText(state: ExpiryState): string | null {
  switch (state.status) {
    case 'expired':
      return 'Expired';
    case 'expiring':
      return state.daysLeft === 1 ? 'Expires in 1 day' : `Expires in ${state.daysLeft} days`;
    case 'valid':
      return 'Valid';
    default:
      return null;
  }
}
