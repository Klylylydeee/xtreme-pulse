import { isValidTin, normalizeTin } from '@pulse/core';

// Spec: docs/modules/talent.md#reimbursements-build-step-25 ("No duplicates") and
// docs/COMPLIANCE.md#reimbursement-receipts-build-step-25 (decisions 241–244 in
// docs/BUILD_PLAN.md) — the two halves of the duplicate key in the `receiptClaims` register. Pure
// code, exported for Pulse Fiscal's petty cash vouchers (step 5.11), so both claim the same way.
//
// *Assumptions, to be confirmed by the accountant:* a TIN with no branch code is the head office,
// the branch is part of the key (invoice series are registered per branch), and receipt numbers
// match ignoring case, separators and leading zeros.

/** Refuses a receipt or invoice number with no letter or digit (its key would be empty). */
export const RECEIPT_NUMBER_NO_KEY_MESSAGE =
  'Enter the receipt or invoice number as printed, with at least one letter or digit.';

/** The head office branch code a 9-digit TIN gets. */
export const HEAD_OFFICE_BRANCH_CODE = '00000';

/**
 * A merchant TIN as typed (dashes and spaces are fine) as the canonical 14 digits: 9 digits get
 * the head office branch `00000`; 12 digits keep the first 9 and pad the 3-digit branch code to 5
 * (`001` → `00001`); 14 digits are kept. Null for anything else (refuse it with Core's
 * `TIN_HELP`).
 */
export function canonicalMerchantTin(value: string): string | null {
  const digits = normalizeTin(value);
  if (!isValidTin(digits)) return null;
  if (digits.length === 9) return `${digits}${HEAD_OFFICE_BRANCH_CODE}`;
  if (digits.length === 12) return `${digits.slice(0, 9)}${digits.slice(9).padStart(5, '0')}`;
  return digits;
}

/** True for a canonical merchant TIN: exactly 14 digits. */
export function isCanonicalMerchantTin(value: string): boolean {
  return /^\d{14}$/.test(value);
}

/**
 * A receipt or invoice number as its key: in capitals, with everything but the letters A–Z and
 * the digits 0–9 removed, then the leading zeros of each run of digits dropped, keeping its last
 * digit (`or-000123`, `OR 123` and `Or123` give `OR123`; `0000` gives `0`). Null when nothing is
 * left (refuse it with `RECEIPT_NUMBER_NO_KEY_MESSAGE`).
 */
export function receiptKey(value: string): string | null {
  const kept = value.toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (kept === '') return null;
  return kept.replace(/(^|[A-Z])0+(?=\d)/g, '$1');
}
