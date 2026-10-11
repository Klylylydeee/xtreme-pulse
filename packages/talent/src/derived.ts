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
