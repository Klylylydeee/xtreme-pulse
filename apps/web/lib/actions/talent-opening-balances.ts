'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { defineAction, MoneyError, OBJECT_ID_PATTERN, parsePesos } from '@pulse/core';
import {
  leaveAdjustmentInputSchema,
  leaveOpeningInputSchema,
  offsetAdjustmentInputSchema,
  offsetOpeningInputSchema,
} from '@pulse/talent';
import {
  addLeaveCorrection,
  addOffsetCorrection,
  canEnterOpeningBalances,
  enterLeaveOpening,
  enterOffsetOpening,
  enterPayrollOpening,
  getLeaveBalances,
  getOffsetBalance,
  getPayrollOpeningSection,
  listLeaveEntries,
  PAYROLL_OPENING_FIELD_LABELS,
  PAYROLL_OPENING_FIELDS,
  payrollOpeningInputSchema,
} from '@pulse/talent/server';
import { requireModuleAccess, signedInUser } from '@/lib/auth';
import { OPENING_BALANCES_HREF } from '@/lib/navigation';

// Spec: docs/modules/talent.md#leave-offset-time-off-and-opening-balances-build-step-28 ("Opening
// balances", "Screens"; decisions 306–308 in docs/BUILD_PLAN.md) and SECURITY.md#sensitive-data —
// the Server Actions behind `/talent/opening-balances` and the employee inspector's Time off
// section and year-to-date pay.
//
// - Every write needs Talent Write here first; the service then checks HR or the System
//   Administrator (the salary rule for year-to-date pay), never one's own record, re-checks the
//   actor's stored access in its transaction and writes the `create` audit entry there.
// - The leave and offset figures are checked here with the same schemas the services use, so
//   every field error comes back at once, and then sent on **as typed** ("2.5" days, "1.25" h):
//   the services take the schemas' input (`z.input`) and are the one place it is parsed. The
//   schemas turn days and hours into half days and minutes, so parsing their output again would
//   read 5 half days as 5 days.
// - Year-to-date pay arrives in pesos as typed and is converted here with `parsePesos` (exact, no
//   floating point) into whole centavos. Nothing returns an amount: a save answers only the new
//   entry's id, and the sections hold masked figures (`••••`), revealed one by one through the
//   audit-logged reveal action.
// - Reading the inspector's sections needs Talent Read here; the services check again who may see
//   the time off (and the confidential types) and who may see year-to-date pay (whoever may reveal
//   `salary`). Nothing here is logged or cached.

const TALENT_READ = 'You don’t have access to Pulse Talent. Ask HR or the System Administrator.';
const TALENT_WRITE =
  'Only HR and the System Administrator, with Talent Write, enter opening balances and corrections.';

const talentReaders = requireModuleAccess('talent', 'read', TALENT_READ);
const talentWriters = requireModuleAccess('talent', 'write', TALENT_WRITE);

const pathOf = (path: PropertyKey[]) => path.map((part) => (typeof part === 'symbol' ? '' : part));

/**
 * Checks the typed fields with `schema` (every error at once) and hands them on unchanged, as the
 * schema's input, to the service that parses them itself.
 */
function checkedAsTyped<TSchema extends z.ZodType<unknown, Record<string, unknown>>>(
  schema: TSchema,
) {
  return z
    .record(z.string(), z.unknown())
    .superRefine((raw, ctx) => {
      const parsed = schema.safeParse(raw);
      if (parsed.success) return;
      for (const issue of parsed.error.issues) {
        ctx.addIssue({ code: 'custom', path: pathOf(issue.path), message: issue.message });
      }
    })
    .pipe(z.custom<z.input<TSchema>>());
}

function refresh() {
  revalidatePath(OPENING_BALANCES_HREF);
  revalidatePath('/talent');
}

/** The year-to-date pay figures in order, with their labels (the labels live server-side). */
function payrollOpeningFields() {
  return PAYROLL_OPENING_FIELDS.map((field) => ({
    field,
    label: PAYROLL_OPENING_FIELD_LABELS[field],
  }));
}

// ---------------------------------------------------------------------------------------------
// Reads

const employeeIdSchema = z.object({ employeeId: z.string().max(100) });

/**
 * The inspector's Time off section: the credited balances and per-year use, the offset balance,
 * the latest leave entries and the regularization flag, and whether this viewer may enter
 * openings and corrections for the employee. Null when there is no such employee.
 */
export const getTimeOffSectionAction = defineAction({
  access: talentReaders,
  schema: employeeIdSchema,
  handler: async ({ employeeId }) => {
    if (!OBJECT_ID_PATTERN.test(employeeId)) return null;
    const user = await signedInUser();
    const [leave, offset, entries] = await Promise.all([
      getLeaveBalances(user, employeeId),
      getOffsetBalance(user, employeeId),
      listLeaveEntries(user, employeeId),
    ]);
    if (!leave || !offset) return null;
    return {
      leave,
      offset,
      entries: (entries ?? []).slice(0, 5),
      canCorrect: canEnterOpeningBalances(user, employeeId),
    };
  },
});

/**
 * Year-to-date pay at go-live for the inspector's Compensation section and the opening balances
 * sheet: masked figures only, for a viewer who may reveal `salary`; null for anyone else.
 */
export const getPayrollOpeningSectionAction = defineAction({
  access: talentReaders,
  schema: employeeIdSchema,
  handler: async ({ employeeId }) => {
    if (!OBJECT_ID_PATTERN.test(employeeId)) return null;
    const section = await getPayrollOpeningSection(await signedInUser(), employeeId);
    return section ? { section, fields: payrollOpeningFields() } : null;
  },
});

// ---------------------------------------------------------------------------------------------
// Openings and corrections

/** "Save" on a VL or SL opening: the days as typed ("2.5"). Answers the new entry's id. */
export const enterLeaveOpeningAction = defineAction({
  access: talentWriters,
  schema: checkedAsTyped(leaveOpeningInputSchema),
  handler: async (input) => {
    // As typed: the service parses the days itself (see above).
    const result = await enterLeaveOpening(await signedInUser(), input);
    refresh();
    return result;
  },
});

/** "Save" on the offset opening: the hours as typed ("12.5"). Answers the new entry's id. */
export const enterOffsetOpeningAction = defineAction({
  access: talentWriters,
  schema: checkedAsTyped(offsetOpeningInputSchema),
  handler: async (input) => {
    const result = await enterOffsetOpening(await signedInUser(), input);
    refresh();
    return result;
  },
});

/** "Add correction" for a credited leave type: signed days as typed, with a reason. */
export const addLeaveCorrectionAction = defineAction({
  access: talentWriters,
  schema: checkedAsTyped(leaveAdjustmentInputSchema),
  handler: async (input) => {
    const result = await addLeaveCorrection(await signedInUser(), input);
    refresh();
    return result;
  },
});

/** "Add correction" for offset: signed hours as typed, with a reason. */
export const addOffsetCorrectionAction = defineAction({
  access: talentWriters,
  schema: checkedAsTyped(offsetAdjustmentInputSchema),
  handler: async (input) => {
    const result = await addOffsetCorrection(await signedInUser(), input);
    refresh();
    return result;
  },
});

// ---------------------------------------------------------------------------------------------
// Year-to-date pay

/** The seven figures as typed, in pesos, each under its `…Centavos` key. */
const PESO_KEYS = PAYROLL_OPENING_FIELDS.map((field) => `${field}Centavos` as const);

const payrollOpeningFormSchema = z.record(z.string(), z.unknown()).transform((raw, ctx) => {
  const converted: Record<string, unknown> = {
    employeeId: raw.employeeId,
    supersedesId: raw.supersedesId,
    reason: raw.reason,
  };
  const unreadable = new Set<string>();
  for (const key of PESO_KEYS) {
    const typed = raw[key];
    const text = typeof typed === 'string' ? typed.trim() : '';
    if (text === '') {
      ctx.addIssue({ code: 'custom', path: [key], message: 'Enter an amount, 0 if none.' });
      unreadable.add(key);
      continue;
    }
    try {
      converted[key] = parsePesos(text);
    } catch (error) {
      ctx.addIssue({
        code: 'custom',
        path: [key],
        message: error instanceof MoneyError ? error.message : 'Enter a valid amount.',
      });
      unreadable.add(key);
    }
  }
  const parsed = payrollOpeningInputSchema.safeParse(converted);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      const path = pathOf(issue.path);
      if (unreadable.has(String(path[0]))) continue;
      ctx.addIssue({ code: 'custom', path, message: issue.message });
    }
    return z.NEVER;
  }
  if (unreadable.size > 0) return z.NEVER;
  return parsed.data;
});

/**
 * "Save" on year-to-date pay at go-live: the first entry, or a correction of the latest one
 * (`supersedesId` and a reason). The figures go to the service in whole centavos; it encrypts
 * them before its transaction. Answers only the new entry's id.
 */
export const enterPayrollOpeningAction = defineAction({
  access: talentWriters,
  schema: payrollOpeningFormSchema,
  handler: async (input) => {
    const result = await enterPayrollOpening(await signedInUser(), input);
    refresh();
    return result;
  },
});
