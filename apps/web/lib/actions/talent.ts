'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { defineAction } from '@pulse/core';
import {
  bankAccountSectionSchema,
  compensationEntryFormSchema,
  employmentSectionSchema,
  governmentIdsSectionSchema,
  personalSectionSchema,
} from '@pulse/talent';
import {
  addCompensationEntry,
  getEmployeeRecordView,
  setBankAccount,
  setGovernmentIds,
  updateEmployment,
  updatePersonal,
} from '@pulse/talent/server';
import { requireModuleAccess, signedInUser } from '@/lib/auth';

// Spec: docs/modules/talent.md#the-employee-record-build-step-21 and SECURITY.md#sensitive-data
// (build step 2.1, decisions 158–170 in docs/BUILD_PLAN.md) — the Server Actions behind the
// `/talent` inspector. Reading a record needs Talent Read and every save Talent Write, checked
// here first (`requireModuleAccess`); each service then checks again in its transaction who may
// change which section (the sensitive sections, the date of birth and civil status, never one's
// own record), refuses a stale form (`version`) and writes the audit entry.
//
// - What comes back holds no plaintext sensitive value: a save answers only the record's new
//   `version` (or the new entry's id), and the record view has the masked values the service
//   built for this viewer (the last 4 digits, or "••••" for a salary), or none of a section the
//   viewer may not see. Full values come only from the reveal action, which is audit-logged.
// - Nothing here is logged or cached. A save refreshes `/talent`, whose list shows the
//   "Not filled in" badge. `/talent/me` reads on the server and has no action: it is read-only.

const TALENT_READ = 'You don’t have access to Pulse Talent. Ask HR or the System Administrator.';
const TALENT_WRITE =
  'You don’t have access to change employee records. Ask HR or the System Administrator.';

const talentReaders = requireModuleAccess('talent', 'read', TALENT_READ);
const talentWriters = requireModuleAccess('talent', 'write', TALENT_WRITE);

/**
 * One employee's record for the inspector, built for the viewer, or null when there is no such
 * employee (or they are separated and `separated` isn't set). Any string: the id may come from a
 * hand-edited `?employee=` link, and the service returns null for a bad one.
 */
export const getEmployeeRecordAction = defineAction({
  access: talentReaders,
  schema: z.object({
    employeeId: z.string().max(100),
    separated: z.boolean().optional(),
  }),
  handler: async ({ employeeId, separated }) =>
    getEmployeeRecordView(await signedInUser(), employeeId, { separated: separated === true }),
});

/** Saves the Personal section. The date of birth and civil status are sent only by HR and the System Administrator. */
export const updatePersonalAction = defineAction({
  access: talentWriters,
  schema: personalSectionSchema,
  handler: async (input) => {
    const result = await updatePersonal(await signedInUser(), input);
    revalidatePath('/talent');
    return { version: result.version };
  },
});

/** Saves Talent's Employment fields (Core's stay in Users). */
export const updateEmploymentAction = defineAction({
  access: talentWriters,
  schema: employmentSectionSchema,
  handler: async (input) => {
    const result = await updateEmployment(await signedInUser(), input);
    revalidatePath('/talent');
    return { version: result.version };
  },
});

/** Saves the Government IDs. An empty ID keeps the stored one. */
export const setGovernmentIdsAction = defineAction({
  access: talentWriters,
  schema: governmentIdsSectionSchema,
  handler: async (input) => {
    const result = await setGovernmentIds(await signedInUser(), input);
    revalidatePath('/talent');
    return { version: result.version };
  },
});

/** Saves the Payroll bank account. An empty account number keeps the stored one. */
export const setBankAccountAction = defineAction({
  access: talentWriters,
  schema: bankAccountSectionSchema,
  handler: async (input) => {
    const result = await setBankAccount(await signedInUser(), input);
    revalidatePath('/talent');
    return { version: result.version };
  },
});

/** "Add salary change": a new compensation entry, the amount typed in pesos. */
export const addCompensationEntryAction = defineAction({
  access: talentWriters,
  schema: compensationEntryFormSchema,
  handler: async (input) => {
    const result = await addCompensationEntry(await signedInUser(), input);
    revalidatePath('/talent');
    return { id: result.id };
  },
});
