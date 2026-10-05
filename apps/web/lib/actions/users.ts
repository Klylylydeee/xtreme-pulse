'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import {
  defineAction,
  employmentStatusChangeSchema,
  OBJECT_ID_PATTERN,
  userCreateSchema,
  userUpdateSchema,
} from '@pulse/core';
import {
  changeEmploymentStatus,
  createUser,
  getUser,
  listEligibleDepartmentHeads,
  resetPassword,
  updateUser,
} from '@pulse/core/server';
import { hrOrSystemAdministratorOnly, signedInUser } from '@/lib/auth';

// Spec: docs/modules/core.md#managing-user-accounts, SECURITY.md#sign-in-and-passwords and
// SECURITY.md#system-administrator — creating and editing user accounts on `/admin/users`, for HR
// and the System Administrator until module access arrives in step 1.6. Each action checks the
// role first; each service checks it again (own row, the system account, a System Administrator's
// email, status and password) and writes its change and audit entries in one transaction.
//
// The temporary password from a create or reset goes only into that action's response, to the
// person who did it. A Server Action's response is never cached (it is a POST), and nothing here
// logs it; the page shows it once and drops it when the dialog closes.

const STALE_RECORD = 'This user no longer exists. Reload the page.';

/** The user an edit, status change or reset acts on. */
const recordId = z.string({ error: STALE_RECORD }).regex(OBJECT_ID_PATTERN, STALE_RECORD);
const byId = z.object({ id: recordId });

/**
 * A form sends one `reportingTo` field per supervisor: none, one (a plain string) or several (an
 * array, see `formDataToObject`). The schemas take an array.
 */
function withReportingToList(raw: unknown): unknown {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return raw;
  const { reportingTo, ...rest } = raw as Record<string, unknown>;
  const list =
    reportingTo === undefined || reportingTo === null || reportingTo === ''
      ? []
      : Array.isArray(reportingTo)
        ? reportingTo
        : [reportingTo];
  return { ...rest, reportingTo: list };
}

/** The pages whose lists change with a user: users, and the employee counts on the others. */
function revalidateAdministration() {
  revalidatePath('/admin', 'layout');
}

/** Creates a user; the response holds the temporary password, shown once. */
export const createUserAction = defineAction({
  access: hrOrSystemAdministratorOnly(),
  schema: z.preprocess(withReportingToList, userCreateSchema),
  handler: async (input) => {
    const created = await createUser(await signedInUser(), input);
    revalidateAdministration();
    return created;
  },
});

/** Edits a user's name, email, date hired, department, position and reporting lines. */
export const updateUserAction = defineAction({
  access: hrOrSystemAdministratorOnly(),
  schema: z.preprocess(withReportingToList, userUpdateSchema.extend({ id: recordId })),
  handler: async ({ id, ...input }) => {
    await updateUser(await signedInUser(), id, input);
    revalidateAdministration();
  },
});

/** Changes a user's employment status (and separation date). Takes effect at once. */
export const changeEmploymentStatusAction = defineAction({
  access: hrOrSystemAdministratorOnly(),
  schema: z.intersection(byId, employmentStatusChangeSchema),
  handler: async ({ id, ...input }) => {
    await changeEmploymentStatus(await signedInUser(), id, input);
    revalidateAdministration();
  },
});

/** Resets a user's password; the response holds the new temporary password, shown once. */
export const resetPasswordAction = defineAction({
  access: hrOrSystemAdministratorOnly(),
  schema: byId,
  handler: async ({ id }) => {
    const result = await resetPassword(await signedInUser(), id);
    revalidateAdministration();
    return result;
  },
});

/** One user for the edit sheet, or null when there is no such user. */
export const getUserAction = defineAction({
  access: hrOrSystemAdministratorOnly(),
  schema: byId,
  handler: async ({ id }) => getUser(await signedInUser(), id),
});

/**
 * Employees who can be picked as a supervisor: active, matched on name or employee number. The
 * person being edited is left out (nobody reports to themselves); the service checks the rest.
 */
export const searchSupervisorsAction = defineAction({
  access: hrOrSystemAdministratorOnly(),
  schema: z.object({
    search: z.string().trim().max(100).default(''),
    excludeEmployeeId: z.string().regex(OBJECT_ID_PATTERN).nullable().optional(),
  }),
  handler: async ({ search, excludeEmployeeId }) => {
    const options = await listEligibleDepartmentHeads(await signedInUser(), search);
    return excludeEmployeeId
      ? options.filter((option) => option.id !== excludeEmployeeId)
      : options;
  },
});
