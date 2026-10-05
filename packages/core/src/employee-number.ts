// Spec: docs/modules/core.md#employee-number-company-id — employee numbers are `YYYY-NN`: the
// hire year and a 2-digit sequence within that year, from 01 to at most 99.

/** The highest sequence in a year; a 100th hire that year fails. */
export const EMPLOYEE_SEQUENCE_MAX = 99;

/** `2027-01` to `2027-99`. */
export const EMPLOYEE_NUMBER_PATTERN = /^\d{4}-(?:0[1-9]|[1-9]\d)$/;

/** The first year an employee number can carry; the counters take 4-digit years only. */
const EMPLOYEE_YEAR_MIN = 1000;
const EMPLOYEE_YEAR_MAX = 9999;

export interface EmployeeNumberParts {
  /** The hire year (its Manila year). */
  year: number;
  /** 1 to 99 within that year. */
  sequence: number;
}

/** `(2027, 1)` → `"2027-01"`. Throws for a year that isn't 4 digits or a sequence outside 1–99. */
export function formatEmployeeNumber(year: number, sequence: number): string {
  if (!Number.isInteger(year) || year < EMPLOYEE_YEAR_MIN || year > EMPLOYEE_YEAR_MAX) {
    throw new RangeError(`${year} is not a 4-digit year.`);
  }
  if (!Number.isInteger(sequence) || sequence < 1 || sequence > EMPLOYEE_SEQUENCE_MAX) {
    throw new RangeError(`An employee number sequence is from 1 to ${EMPLOYEE_SEQUENCE_MAX}.`);
  }
  return `${year}-${String(sequence).padStart(2, '0')}`;
}

/**
 * `"2027-01"` → `{ year: 2027, sequence: 1 }`, or null if it isn't an employee number. Spaces
 * around it are ignored; anything else (`2027-1`, `2027-00`, `2027-100`, `27-01`) is refused, so
 * each number has one spelling.
 */
export function parseEmployeeNumber(value: string): EmployeeNumberParts | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!EMPLOYEE_NUMBER_PATTERN.test(trimmed)) return null;
  const year = Number(trimmed.slice(0, 4));
  const sequence = Number(trimmed.slice(5));
  if (year < EMPLOYEE_YEAR_MIN) return null;
  return { year, sequence };
}
