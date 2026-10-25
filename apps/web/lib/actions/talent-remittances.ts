'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { type AccessCheck, defineAction, MoneyError, parsePesos } from '@pulse/core';
import {
  assertCanGenerateRemittances,
  assertCanRecordRemittancePayments,
  assertCanSeeRemittances,
  correctRemittancePayment,
  exportRemittanceReport,
  generateRemittanceReport,
  recordRemittancePayment,
  REMITTANCE_NOT_FOUND,
  type RemittanceAmountsView,
  remittanceReportHref,
  REMITTANCES_HREF,
  showRemittanceAmounts,
  voidRemittancePayment,
} from '@pulse/talent/server';
import { REMITTANCE_AGENCIES, REMITTANCE_EXPORT_FORMATS } from '@pulse/talent';
import { signedInUser } from '@/lib/auth';

// Spec: docs/modules/talent.md#employer-contributions-and-remittances-build-step-211 ("Reports",
// "Exports", "Payments", "Who may see and do what", "Screens"; decisions 385–396 in
// docs/BUILD_PLAN.md) and SECURITY.md#sensitive-data ("Remittances") — the Server Actions behind
// `/talent/remittances/<YYYY-MM>/<agency>`.
//
// - Access is checked here first, against the signed-in user, and again in the services: seeing,
//   "Show amounts" and the exports need Talent Read and HR, Accounting or the System
//   Administrator; "Generate report" and "Regenerate" Talent Write and HR or the System
//   Administrator; "Record payment", "Correct" and "Void" Talent Write and HR, Accounting or the
//   System Administrator.
// - Amounts leave the server only from "Show amounts" (a `reveal` on the report, field `amounts`,
//   first) and the payment sheets' amount warning (a `reveal`, field `amountDue`, first). The
//   exports answer a file route URL only, after their `export` entry. Every other action answers
//   ids, versions or counts.
// - The amount paid is typed in pesos and converted here with `parsePesos` (exact, no floating
//   point). Nothing here is logged or cached; refusals come back in the services' words.

const agencyField = z.enum(REMITTANCE_AGENCIES, { error: REMITTANCE_NOT_FOUND });
const monthField = z
  .string({ error: REMITTANCE_NOT_FOUND })
  .regex(/^\d{4}-(0[1-9]|1[0-2])$/, REMITTANCE_NOT_FOUND);
const versionField = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const textField = (max: number) => z.string().max(max);
const idField = z.string().max(100);

/** Talent Read and HR, Accounting or the System Administrator. */
const remittanceReaders: AccessCheck = async () => {
  assertCanSeeRemittances(await signedInUser());
};

/** Talent Write and HR or the System Administrator. */
const remittanceGenerators: AccessCheck = async () => {
  assertCanGenerateRemittances(await signedInUser());
};

/** Talent Write and HR, Accounting or the System Administrator. */
const paymentRecorders: AccessCheck = async () => {
  assertCanRecordRemittancePayments(await signedInUser());
};

function revalidateReport(month: string, agency: (typeof REMITTANCE_AGENCIES)[number]) {
  revalidatePath(REMITTANCES_HREF);
  revalidatePath(remittanceReportHref(month, agency));
}

/** The amount paid, typed in pesos: whole centavos, or a field error. */
const pesosField = z.string({ error: 'Enter the amount paid.' }).transform((text, ctx) => {
  if (text.trim() === '') {
    ctx.addIssue({ code: 'custom', message: 'Enter the amount paid.' });
    return z.NEVER;
  }
  try {
    return parsePesos(text);
  } catch (error) {
    ctx.addIssue({
      code: 'custom',
      message: error instanceof MoneyError ? error.message : 'Enter a valid amount.',
    });
    return z.NEVER;
  }
});

/** "Generate report" or "Regenerate" (with the version the page shows). */
export const generateRemittanceReportAction = defineAction({
  access: remittanceGenerators,
  schema: z.object({ agency: agencyField, month: monthField, version: versionField.optional() }),
  handler: async ({ agency, month, version }) => {
    const user = await signedInUser();
    const done = await generateRemittanceReport(user, { agency, month, version });
    revalidateReport(month, agency);
    return done;
  },
});

/** "Show amounts": the `reveal` first, then the rows (IDs masked), totals and payment amounts. */
export const showRemittanceAmountsAction = defineAction({
  access: remittanceReaders,
  schema: z.object({ agency: agencyField, month: monthField }),
  handler: async ({ agency, month }): Promise<RemittanceAmountsView | null> => {
    const user = await signedInUser();
    return showRemittanceAmounts(user, { agency, month });
  },
});

/** "PDF", "Excel" or "Upload file": the `export` entry first; answers the file route URL. */
export const exportRemittanceReportAction = defineAction({
  access: remittanceReaders,
  schema: z.object({
    agency: agencyField,
    month: monthField,
    format: z.enum(REMITTANCE_EXPORT_FORMATS),
    version: versionField,
  }),
  handler: async (input) => {
    const user = await signedInUser();
    const exported = await exportRemittanceReport(user, input);
    revalidateReport(input.month, input.agency);
    return { href: exported.href };
  },
});

const paymentFields = {
  agency: agencyField,
  month: monthField,
  paidOn: textField(20),
  referenceNumber: textField(200),
  amountCentavos: pesosField,
  note: textField(1000).optional(),
  confirmAmount: z.boolean().optional(),
};

/** "Record payment": saves, or answers the amount warning (nothing saved). */
export const recordRemittancePaymentAction = defineAction({
  access: paymentRecorders,
  schema: z.object({ ...paymentFields, version: versionField }),
  handler: async (input) => {
    const user = await signedInUser();
    const result = await recordRemittancePayment(user, input);
    if (result.status === 'saved') revalidateReport(input.month, input.agency);
    return result.status === 'saved'
      ? { status: 'saved' as const }
      : { status: 'amountDiffers' as const, message: result.message };
  },
});

/** "Correct payment": a new entry superseding the live one, with a reason. */
export const correctRemittancePaymentAction = defineAction({
  access: paymentRecorders,
  schema: z.object({ ...paymentFields, paymentId: idField, reason: textField(1000) }),
  handler: async (input) => {
    const user = await signedInUser();
    const result = await correctRemittancePayment(user, { ...input, version: undefined });
    if (result.status === 'saved') revalidateReport(input.month, input.agency);
    return result.status === 'saved'
      ? { status: 'saved' as const }
      : { status: 'amountDiffers' as const, message: result.message };
  },
});

/** "Void payment", with a reason: the report is back to "Generated". */
export const voidRemittancePaymentAction = defineAction({
  access: paymentRecorders,
  schema: z.object({
    agency: agencyField,
    month: monthField,
    paymentId: idField,
    reason: textField(1000),
  }),
  handler: async (input) => {
    const user = await signedInUser();
    await voidRemittancePayment(user, input);
    revalidateReport(input.month, input.agency);
    return { status: 'voided' as const };
  },
});
