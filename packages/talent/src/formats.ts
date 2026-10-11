// Spec: docs/modules/talent.md#the-employee-record-build-step-21 ("Formats", decision 165 in
// docs/BUILD_PLAN.md) — government IDs, the bank account number and mobile numbers are stored as
// digit strings, leading zeros kept, and shown formatted. *Assumption, to be confirmed by HR or
// counsel:* the digit counts and display formats below. Pure code, safe in the browser.

/** TIN: no branch code, a 3-digit branch code, or BIR's 5-digit branch code. */
export const TIN_DIGIT_COUNTS = [9, 12, 14] as const;
export const RDO_CODE_DIGITS = 3;
export const SSS_DIGITS = 10;
export const PHILHEALTH_DIGITS = 12;
export const PAGIBIG_DIGITS = 12;
/** UnionBank and RCBC account numbers. */
export const BANK_ACCOUNT_MIN_DIGITS = 10;
export const BANK_ACCOUNT_MAX_DIGITS = 16;
/** Philippine mobile numbers: 11 digits starting with `09`. */
export const MOBILE_NUMBER_PATTERN = /^09\d{9}$/;

const DIGITS = /^\d+$/;

/**
 * What a person typed, with the spaces, dashes and dots people put in IDs removed. Anything else
 * (letters, other symbols) is kept, so the format check refuses it rather than silently dropping
 * it.
 */
export function normalizeDigits(text: string): string {
  return text.replace(/[\s.\-–—]/g, '');
}

const isDigits = (value: string, length: number) => DIGITS.test(value) && value.length === length;

export const isTin = (value: string) =>
  DIGITS.test(value) && (TIN_DIGIT_COUNTS as readonly number[]).includes(value.length);
export const isRdoCode = (value: string) => isDigits(value, RDO_CODE_DIGITS);
export const isSssNumber = (value: string) => isDigits(value, SSS_DIGITS);
export const isPhilhealthPin = (value: string) => isDigits(value, PHILHEALTH_DIGITS);
export const isPagibigMid = (value: string) => isDigits(value, PAGIBIG_DIGITS);
export const isBankAccountNumber = (value: string) =>
  DIGITS.test(value) &&
  value.length >= BANK_ACCOUNT_MIN_DIGITS &&
  value.length <= BANK_ACCOUNT_MAX_DIGITS;
export const isMobileNumber = (value: string) => MOBILE_NUMBER_PATTERN.test(value);

/** Splits `digits` into groups of the given sizes, joined by `separator`. */
function group(digits: string, sizes: readonly number[], separator: string): string {
  const parts: string[] = [];
  let at = 0;
  for (const size of sizes) {
    parts.push(digits.slice(at, at + size));
    at += size;
  }
  return parts.join(separator);
}

/** `000-000-000`, `000-000-000-000` or `000-000-000-00000`; anything else as it is. */
export function formatTin(digits: string): string {
  if (!isTin(digits)) return digits;
  if (digits.length === 9) return group(digits, [3, 3, 3], '-');
  if (digits.length === 12) return group(digits, [3, 3, 3, 3], '-');
  return group(digits, [3, 3, 3, 5], '-');
}

/** `000`. */
export function formatRdoCode(digits: string): string {
  return digits;
}

/** `00-0000000-0`. */
export function formatSssNumber(digits: string): string {
  return isSssNumber(digits) ? group(digits, [2, 7, 1], '-') : digits;
}

/** `00-000000000-0`. */
export function formatPhilhealthPin(digits: string): string {
  return isPhilhealthPin(digits) ? group(digits, [2, 9, 1], '-') : digits;
}

/** `0000-0000-0000`. */
export function formatPagibigMid(digits: string): string {
  return isPagibigMid(digits) ? group(digits, [4, 4, 4], '-') : digits;
}

/** The digits as entered. */
export function formatBankAccountNumber(digits: string): string {
  return digits;
}

/** `0917 123 4567`. */
export function formatMobileNumber(digits: string): string {
  return isMobileNumber(digits) ? group(digits, [4, 3, 4], ' ') : digits;
}

/** The mask for a salary amount: no digits at all (SECURITY.md#sensitive-data). */
export const SALARY_MASK = '••••';
