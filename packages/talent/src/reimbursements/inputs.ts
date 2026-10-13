import { z } from 'zod';
import { businessDateField, OBJECT_ID_PATTERN, TIN_HELP } from '@pulse/core';
import { positiveCentavosField } from '../payroll/schemas';
import { entryClientField } from '../timesheets/inputs';
import { canonicalMerchantTin, RECEIPT_NUMBER_NO_KEY_MESSAGE, receiptKey } from './receipt-key';

// Spec: docs/modules/talent.md#reimbursements-build-step-25 ("Reimbursement lines", "Checks",
// "Check a receipt"; decisions 238–245 in docs/BUILD_PLAN.md) — the inputs of the reimbursement
// sheet and of "Check a receipt", as the services take them. Pure code, safe in the browser: the
// forms parse with the same schemas, and the services parse again.
//
// No employee id is taken: the services act on the signed-in user's own employee. The amount is
// whole centavos; the form reads what is typed in pesos with Core's `parsePesos` (which refuses
// more than 2 decimal places) and sends the centavos. The receipt file travels beside the input
// (form field `receipt`), not in it.

/** A merchant's name: 1 to 120 characters. */
export const MERCHANT_MAX_LENGTH = 120;
/** A receipt or invoice number, as typed: 1 to 40 characters. */
export const RECEIPT_NUMBER_MAX_LENGTH = 40;
/** Pick-up and drop-off: 1 to 200 characters each. */
export const ROUTE_MAX_LENGTH = 200;
/** A description of the expense: 1 to 300 characters. */
export const REIMBURSEMENT_DESCRIPTION_MAX_LENGTH = 300;

const trimmed = (value: unknown) => (typeof value === 'string' ? value.trim() : value);
const emptyToNull = (value: unknown) => {
  const text = trimmed(value);
  return text === '' || text === undefined ? null : text;
};

function requiredText(missing: string, max: number) {
  return z.preprocess(
    trimmed,
    z.string({ error: missing }).min(1, missing).max(max, `Use at most ${max} characters.`),
  );
}

function optionalText(max: number) {
  return z.preprocess(
    emptyToNull,
    z.string().max(max, `Use at most ${max} characters.`).nullable(),
  );
}

/** A merchant TIN as typed: 9, 12 or 14 digits, dashes and spaces fine (kept as typed here). */
export const merchantTinField = z.preprocess(
  trimmed,
  z
    .string({ error: TIN_HELP })
    .refine((value) => canonicalMerchantTin(value) !== null, { message: TIN_HELP }),
);

/** A receipt or invoice number as typed (1 to 40 characters, with a letter or digit). */
export const receiptNumberField = requiredText(
  'Enter the receipt or invoice number.',
  RECEIPT_NUMBER_MAX_LENGTH,
).refine((value) => typeof value === 'string' && receiptKey(value) !== null, {
  message: RECEIPT_NUMBER_NO_KEY_MESSAGE,
});

const lineFields = {
  /** A key of the `talent.reimbursementSettings` version in effect on the receipt date. */
  typeKey: z.preprocess(
    trimmed,
    z.string({ error: 'Choose the type.' }).min(1, 'Choose the type.').max(40, 'Choose the type.'),
  ),
  /** The Manila day printed on the receipt. */
  receiptDate: businessDateField('Enter the receipt date.'),
  merchant: requiredText('Enter the merchant.', MERCHANT_MAX_LENGTH),
  merchantTin: merchantTinField,
  receiptNumber: receiptNumberField,
  /** A positive whole number of centavos. */
  amountCentavos: positiveCentavosField,
  /** For tracking only, never billed. Empty means none. */
  clientId: entryClientField,
  /** Required when the type requires the route; otherwise empty (stored as null). */
  pickUp: optionalText(ROUTE_MAX_LENGTH),
  dropOff: optionalText(ROUTE_MAX_LENGTH),
  /** Required when the type requires it; optional otherwise. */
  description: optionalText(REIMBURSEMENT_DESCRIPTION_MAX_LENGTH),
};

const NOT_FOUND = 'This reimbursement can’t be found. Reload to see it.';
const idField = (message: string) => z.string({ error: message }).regex(OBJECT_ID_PATTERN, message);
const versionField = z
  .number({ error: 'Reload the page and try again.' })
  .int('Reload the page and try again.')
  .min(1, 'Reload the page and try again.');

/** "Add reimbursement": a new line on the employee's own timesheet being viewed. */
export const createReimbursementSchema = z.object({
  timesheetId: idField('This timesheet can’t be found. Reload to see it.'),
  ...lineFields,
});
export type CreateReimbursementInput = z.input<typeof createReimbursementSchema>;

/** The edit sheet: the whole line, with the `version` it was loaded at. */
export const updateReimbursementSchema = z.object({
  reimbursementId: idField(NOT_FOUND),
  version: versionField,
  ...lineFields,
});
export type UpdateReimbursementInput = z.input<typeof updateReimbursementSchema>;

/** "Delete reimbursement", after the confirmation. */
export const deleteReimbursementSchema = z.object({
  reimbursementId: idField(NOT_FOUND),
  version: versionField,
});
export type DeleteReimbursementInput = z.input<typeof deleteReimbursementSchema>;

/** "Check a receipt" on `/talent`: a merchant TIN and a receipt or invoice number, as typed. */
export const checkReceiptSchema = z.object({
  merchantTin: merchantTinField,
  receiptNumber: receiptNumberField,
});
export type CheckReceiptInput = z.input<typeof checkReceiptSchema>;
