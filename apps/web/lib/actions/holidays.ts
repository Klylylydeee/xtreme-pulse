'use server';

import { z } from 'zod';
import {
  type BusinessDate,
  businessDateField,
  declareHolidaySchema,
  defineAction,
  holidayActionSchema,
  holidayInputSchema,
  holidayUpdateSchema,
  holidayYearSchema,
  OBJECT_ID_PATTERN,
} from '@pulse/core';
import {
  confirmHoliday,
  confirmHolidayYear,
  createHoliday,
  declareHoliday,
  deleteHoliday,
  findHolidaysOnDate,
  type HolidayAutoDraftResult,
  HolidayLegalBasisMissingError,
  runHolidayAutoDraft,
  type SameDateHoliday,
  updateHoliday,
} from '@pulse/core/server';
import { adminOnly, signedInUser } from '@/lib/auth';

// Spec: docs/modules/core.md#holiday-calendar (build step 1.10, decisions 111–132 in
// docs/BUILD_PLAN.md) — the Server Actions behind `/holidays`. The page is open to every signed-in
// user, but only HR and the System Administrator manage holidays (SECURITY.md#rules): every action
// here checks that role first (`adminOnly('hrOrSystemAdministrator')`, the same rule as
// `canManageHolidays`), and each service checks it again and writes its change and audit entry in
// one transaction. Reading the list needs no action: the page reads it on the server.

const MANAGE_HOLIDAYS = 'Only HR and the System Administrator can manage holidays.';
const managersOnly = adminOnly('hrOrSystemAdministrator', MANAGE_HOLIDAYS);

const yearInput = z.object({ year: holidayYearSchema });

/** Adds a holiday as a draft. */
export const createHolidayAction = defineAction({
  access: managersOnly,
  schema: holidayInputSchema,
  handler: async (input) => createHoliday(await signedInUser(), input),
});

/** Edits a holiday, refusing a stale sheet (`expectedUpdatedAt`). */
export const updateHolidayAction = defineAction({
  access: managersOnly,
  schema: holidayUpdateSchema,
  handler: async (input) => updateHoliday(await signedInUser(), input),
});

/** Confirms one draft. It needs a legal basis. */
export const confirmHolidayAction = defineAction({
  access: managersOnly,
  schema: holidayActionSchema,
  handler: async (input) => confirmHoliday(await signedInUser(), input),
});

/** What Confirm all answers: the drafts it confirmed, or the drafts still missing a legal basis. */
export type ConfirmHolidayYearResult =
  | { status: 'confirmed'; confirmed: number; dates: BusinessDate[] }
  | { status: 'legalBasisMissing'; drafts: { id: string; name: string; date: BusinessDate }[] };

/**
 * Confirm all for a year. Refused, confirming nothing, while any draft has no legal basis; that
 * refusal comes back as data, so the dialog can list the drafts.
 */
export const confirmHolidayYearAction = defineAction({
  access: managersOnly,
  schema: yearInput,
  handler: async ({ year }): Promise<ConfirmHolidayYearResult> => {
    try {
      const result = await confirmHolidayYear(await signedInUser(), year);
      return { status: 'confirmed', ...result };
    } catch (error) {
      if (error instanceof HolidayLegalBasisMissingError) {
        return { status: 'legalBasisMissing', drafts: error.drafts };
      }
      throw error;
    }
  },
});

/** Declares a holiday at short notice: confirmed at once, and every active user is notified. */
export const declareHolidayAction = defineAction({
  access: managersOnly,
  schema: declareHolidaySchema,
  handler: async (input) => declareHoliday(await signedInUser(), input),
});

/** Deletes a holiday (a soft delete; no restore screen). */
export const deleteHolidayAction = defineAction({
  access: managersOnly,
  schema: holidayActionSchema,
  handler: async (input) => deleteHoliday(await signedInUser(), input),
});

/** Runs the auto-draft for the current or next year, as the signed-in user. */
export const runHolidayAutoDraftAction = defineAction({
  access: managersOnly,
  schema: yearInput,
  handler: async ({ year }): Promise<HolidayAutoDraftResult> =>
    runHolidayAutoDraft({ year, actor: await signedInUser() }),
});

/** The live holidays already on a date, for the form's non-blocking warning. */
export const findHolidaysOnDateAction = defineAction({
  access: managersOnly,
  schema: z.object({
    date: businessDateField(),
    exceptId: z.string().regex(OBJECT_ID_PATTERN).nullish(),
  }),
  handler: async ({ date, exceptId }): Promise<SameDateHoliday[]> =>
    findHolidaysOnDate(await signedInUser(), date as BusinessDate, { exceptId: exceptId ?? null }),
});
