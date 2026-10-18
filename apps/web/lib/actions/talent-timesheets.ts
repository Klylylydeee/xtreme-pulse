'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { defineAction, OBJECT_ID_PATTERN } from '@pulse/core';
import {
  createTimeEntrySchema,
  deleteTimeEntrySchema,
  timeOutSchema,
  updateTimeEntrySchema,
} from '@pulse/talent';
import {
  createTimeEntry,
  deleteTimeEntry,
  submitTimesheet,
  timeIn,
  timeOut,
  updateTimeEntry,
} from '@pulse/talent/server';
import { requireSignedIn, signedInUser } from '@/lib/auth';

// Spec: docs/modules/talent.md#work-schedules-and-daily-time-entries-build-step-24 ("Time
// entries", "Who may do what"; decisions 219–221 in docs/BUILD_PLAN.md) and
// SECURITY.md#exceptions-to-module-access ("The own timesheet") — the Server Actions behind
// `/talent/timesheet`. Self-service, outside module access: each action needs only a signed-in user
// (`requireSignedIn`) and acts on that user's own employee. None takes an employee id, and none
// sends a time's source: the services store `clock` for Time in and Time out (the server's time)
// and `manual` for a typed time. The services reload the actor, refuse the bootstrap system
// account (no employee) and check every entry rule again in their transaction.
//
// Each returns only ids, versions and statuses; the page reloads its view to show the change.
// Nothing here is logged or cached.
//
// Step 2.7 (docs/modules/talent.md#timesheet-approval-the-dtr-and-the-offset-balance-build-step-27,
// "Submitting"; assumption 146): "Submit timesheet" (or "Resubmit") takes only the timesheet's id,
// never an employee id, and the service refuses any timesheet that isn't the signed-in user's own
// (it reads as not found). A missing onboarding item comes back as the form error, naming it.

const OWN_TIMESHEET = '/talent/timesheet';

/** Time in: one tap, the server's time. */
export const timeInAction = defineAction({
  access: requireSignedIn(),
  schema: z.object({}),
  handler: async () => {
    const result = await timeIn(await signedInUser());
    revalidatePath(OWN_TIMESHEET);
    return { entryId: result.entryId, version: result.version };
  },
});

/**
 * Time out: the server's time. `activityRequired` when the open entry has no activity and none was
 * sent: the page asks for it in the entry sheet and calls again with it.
 */
export const timeOutAction = defineAction({
  access: requireSignedIn(),
  schema: timeOutSchema,
  handler: async (input) => {
    const result = await timeOut(await signedInUser(), input);
    if (result.status === 'timedOut') revalidatePath(OWN_TIMESHEET);
    return { status: result.status, entryId: result.entryId, version: result.version };
  },
});

/** "Add entry" on the day sheet: typed (manual) times. */
export const createTimeEntryAction = defineAction({
  access: requireSignedIn(),
  schema: createTimeEntrySchema,
  handler: async (input) => {
    const result = await createTimeEntry(await signedInUser(), input);
    revalidatePath(OWN_TIMESHEET);
    return { id: result.id, version: result.version };
  },
});

/** The edit sheet: the whole entry, with the version it was loaded at (a stale save is refused). */
export const updateTimeEntryAction = defineAction({
  access: requireSignedIn(),
  schema: updateTimeEntrySchema,
  handler: async (input) => {
    const result = await updateTimeEntry(await signedInUser(), input);
    revalidatePath(OWN_TIMESHEET);
    return { id: result.id, version: result.version };
  },
});

/** "Delete entry", after the confirmation: a soft delete against the entry's version. */
export const deleteTimeEntryAction = defineAction({
  access: requireSignedIn(),
  schema: deleteTimeEntrySchema,
  handler: async (input) => {
    await deleteTimeEntry(await signedInUser(), input);
    revalidatePath(OWN_TIMESHEET);
    return null;
  },
});

/** "Submit timesheet" or "Resubmit", from the confirmation sheet: the own timesheet only. */
export const submitTimesheetAction = defineAction({
  access: requireSignedIn(),
  schema: z.object({
    timesheetId: z.string().regex(OBJECT_ID_PATTERN, 'Reload the page and try again.'),
  }),
  handler: async (input) => {
    const result = await submitTimesheet(await signedInUser(), { timesheetId: input.timesheetId });
    revalidatePath(OWN_TIMESHEET);
    return {
      timesheetId: result.timesheetId,
      status: result.status,
      submittedLate: result.submittedLate,
    };
  },
});
