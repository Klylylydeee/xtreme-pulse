'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { defineAction, MoneyError, parsePesos } from '@pulse/core';
import {
  type CreateReimbursementInput,
  createReimbursementSchema,
  deleteReimbursementSchema,
  type UpdateReimbursementInput,
  updateReimbursementSchema,
} from '@pulse/talent';
import { addReimbursement, deleteReimbursement, updateReimbursement } from '@pulse/talent/server';
import { requireSignedIn, signedInUser } from '@/lib/auth';

// Spec: docs/modules/talent.md#reimbursements-build-step-25 ("Reimbursement lines", "Checks",
// "Who may do what"; decisions 238–252 in docs/BUILD_PLAN.md) and
// SECURITY.md#exceptions-to-module-access ("The own timesheet") — the Server Actions behind the
// Reimbursements segment of `/talent/timesheet`. Self-service, outside module access: each action
// needs only a signed-in user (`requireSignedIn`) and acts on that user's own employee. None takes
// an employee id: the services load the signed-in user's own employee and timesheet, refuse the
// bootstrap system account (no employee), and check every rule again in their transaction
// (the filing window, the type's required fields, the duplicate receipt, the line's `version`).
//
// - The sheet sends FormData: the line's fields, the amount as typed in pesos under
//   `amountCentavos` (converted here with Core's `parsePesos`: exact, no floating point), the
//   `version` as digits, and the receipt photo or PDF under `receipt`. On edit, leaving `receipt`
//   out keeps the stored file.
// - A duplicate receipt comes back under `receiptNumber`, a missing receipt under `receipt`.
// - Each returns only the line's id, version and over-limit flag; the page reloads its view to
//   show the change. Nothing here is logged or cached.

const OWN_TIMESHEET = '/talent/timesheet';
const AMOUNT_MISSING = 'Enter the amount.';

/** The receipt the form sent: an empty file input (size 0) or none counts as no file. */
function receiptOf(value: unknown): File | null {
  return value instanceof File && value.size > 0 ? value : null;
}

const pathOf = (path: PropertyKey[]) => path.map((part) => (typeof part === 'symbol' ? '' : part));

/**
 * The sheet's FormData as `schema` takes it, with the receipt beside it. The amount is read from
 * pesos here; its problem is reported once, under `amountCentavos`, with every other field's
 * error at the same time.
 */
function lineForm<TSchema extends z.ZodType>(schema: TSchema) {
  return z.record(z.string(), z.unknown()).transform((raw, ctx) => {
    const { receipt, ...fields } = raw;
    const values: Record<string, unknown> = { ...fields };
    let amountRead = true;
    if ('amountCentavos' in fields) {
      const text = typeof fields.amountCentavos === 'string' ? fields.amountCentavos.trim() : '';
      if (text === '') {
        ctx.addIssue({ code: 'custom', path: ['amountCentavos'], message: AMOUNT_MISSING });
        amountRead = false;
      } else {
        try {
          values.amountCentavos = parsePesos(text);
        } catch (error) {
          ctx.addIssue({
            code: 'custom',
            path: ['amountCentavos'],
            message: error instanceof MoneyError ? error.message : 'Enter a valid amount.',
          });
          amountRead = false;
        }
      }
    }
    if (typeof fields.version === 'string') {
      const text = fields.version.trim();
      // Left as text when it isn't digits, so the schema refuses it.
      values.version = /^\d{1,15}$/.test(text) ? Number(text) : text;
    }
    const parsed = schema.safeParse(values);
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        const path = pathOf(issue.path);
        if (!amountRead && path[0] === 'amountCentavos') continue;
        ctx.addIssue({ code: 'custom', path, message: issue.message });
      }
    }
    if (!parsed.success || !amountRead) return z.NEVER;
    return { input: values, receipt: receiptOf(receipt) };
  });
}

/** "Add reimbursement": a new line on the own timesheet being viewed, with its receipt. */
export const addReimbursementAction = defineAction({
  access: requireSignedIn(),
  schema: lineForm(createReimbursementSchema),
  handler: async ({ input, receipt }) => {
    const result = await addReimbursement(
      await signedInUser(),
      input as CreateReimbursementInput,
      receipt,
    );
    revalidatePath(OWN_TIMESHEET);
    return { id: result.id, version: result.version, overLimit: result.overLimit };
  },
});

/**
 * The edit sheet: the whole line with the `version` it was loaded at (a stale save is refused). A
 * new receipt replaces the stored one; none keeps it.
 */
export const updateReimbursementAction = defineAction({
  access: requireSignedIn(),
  schema: lineForm(updateReimbursementSchema),
  handler: async ({ input, receipt }) => {
    const result = await updateReimbursement(
      await signedInUser(),
      input as UpdateReimbursementInput,
      receipt,
    );
    revalidatePath(OWN_TIMESHEET);
    return { id: result.id, version: result.version, overLimit: result.overLimit };
  },
});

/** "Delete reimbursement", after the confirmation: a soft delete that frees the receipt's claim. */
export const deleteReimbursementAction = defineAction({
  access: requireSignedIn(),
  schema: deleteReimbursementSchema,
  handler: async (input) => {
    await deleteReimbursement(await signedInUser(), input);
    revalidatePath(OWN_TIMESHEET);
    return null;
  },
});
