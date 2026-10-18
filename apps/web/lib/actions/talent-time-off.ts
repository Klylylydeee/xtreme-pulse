'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { defineAction, OBJECT_ID_PATTERN } from '@pulse/core';
import {
  cancelTimeOffInputSchema,
  employeeTimeOffHref,
  OWN_TIME_OFF_HREF,
  type TimeOffPreviewView,
  timeOffRequestHref,
} from '@pulse/talent';
import {
  cancelTimeOff,
  fileTimeOff,
  previewTimeOff,
  resendTimeOff,
  TimeOffRefusedError,
} from '@pulse/talent/server';
import { requireSignedIn, signedInUser } from '@/lib/auth';

// Spec: docs/modules/talent.md#leave-offset-time-off-and-opening-balances-build-step-28 ("Filing a
// leave request", "Filing offset time off", "Approval": edit and send again, cancelling; "Screens":
// the request sheet) and SECURITY.md#exceptions-to-module-access ("The own time off and the
// team's") — the Server Actions behind `/talent/time-off`. Self-service, outside module access:
// each needs only a signed-in user (`requireSignedIn`) and acts on that user's own employee. None
// takes an employee id: the services load the signed-in user's own employee in their transaction,
// refuse the bootstrap system account (no employee), refuse anyone else's request as not found,
// and check every rule again (the onboarding gate, the filing window, the balance, the overlap).
//
// - The sheet sends FormData: the request's fields as the sheet holds them (`kind`, `leaveTypeKey`
//   or `fromTime` and `toTime`, `startDate`, `endDate`, `portion`, `reason`) and the attachment
//   under `attachment` (an empty file input counts as none). The services parse the fields with
//   `timeOffRequestInputSchema`; a refusal comes back next to its field in the service's words.
// - A refusal that offers a link (an empty sex on the employee record: "Add your sex on My record
//   first…") comes back as data (`refused`) with the field, the words and My record's link, since
//   a failed action result carries no link.
// - The preview writes nothing: the days with their charge, the split, and every problem found so
//   far, in the service's words.
// - Each change returns only the request's id, number and status; the pages reload their views to
//   show it. Nothing here is logged or cached.

/** The file the form sent under `attachment`: an empty file input (size 0) or none counts as none. */
function attachmentOf(value: unknown): File | null {
  return value instanceof File && value.size > 0 ? value : null;
}

/** The sheet's FormData: the request's fields (as text), with the attachment beside them. */
const requestForm = z.record(z.string(), z.unknown()).transform((raw) => {
  // `requestId` and `hasAttachment` travel beside the request's fields, not in them.
  const { attachment, ...fields } = raw;
  delete fields.requestId;
  delete fields.hasAttachment;
  return { input: fields, attachment: attachmentOf(attachment) };
});

const TIME_OFF_REQUEST_MISSING = 'This request can’t be found. Reload to see it.';

const requestIdField = z
  .string({ error: 'Choose a request.' })
  .regex(OBJECT_ID_PATTERN, 'Choose a request.');

/** What filing or sending again returns: the request, or a refusal with a link to follow. */
export type TimeOffSubmitResult =
  | { kind: 'filed'; id: string; number: string; status: 'pending' }
  | { kind: 'refused'; field: string | null; message: string; href: string };

/** Runs a filing, turning a refusal that offers a link into data the sheet can show with it. */
async function submitting(
  run: () => Promise<{ id: string; number: string; status: 'pending' }>,
): Promise<TimeOffSubmitResult> {
  try {
    const result = await run();
    return { kind: 'filed', ...result };
  } catch (error) {
    if (error instanceof TimeOffRefusedError && error.href) {
      return { kind: 'refused', field: error.field, message: error.message, href: error.href };
    }
    throw error;
  }
}

/** After a change: the own time off, the read-only view of it, and the request's page. */
function revalidateTimeOff(employeeId: string | null, requestId: string) {
  revalidatePath(OWN_TIME_OFF_HREF);
  if (employeeId) revalidatePath(employeeTimeOffHref(employeeId));
  revalidatePath(timeOffRequestHref(requestId));
}

/** "Submit" on the request sheet: files the signed-in user's own leave or offset time off. */
export const fileTimeOffAction = defineAction({
  access: requireSignedIn(),
  schema: requestForm,
  handler: async ({ input, attachment }) => {
    const user = await signedInUser();
    const result = await submitting(() => fileTimeOff(user, input, attachment));
    if (result.kind === 'filed') revalidateTimeOff(user.employee?.id ?? null, result.id);
    return result;
  },
});

/**
 * "Edit and send again" on a returned request (the own request only): the sheet's values again, of
 * the same kind. A new file replaces the attachment; none keeps the request's own.
 */
export const resendTimeOffAction = defineAction({
  access: requireSignedIn(),
  schema: z.record(z.string(), z.unknown()).transform((raw, ctx) => {
    const requestId = requestIdField.safeParse(raw.requestId);
    if (!requestId.success) {
      ctx.addIssue({ code: 'custom', path: [], message: TIME_OFF_REQUEST_MISSING });
      return z.NEVER;
    }
    return { requestId: requestId.data, ...requestForm.parse(raw) };
  }),
  handler: async ({ requestId, input, attachment }) => {
    const user = await signedInUser();
    const result = await submitting(() => resendTimeOff(user, requestId, input, attachment));
    if (result.kind === 'filed') revalidateTimeOff(user.employee?.id ?? null, result.id);
    return result;
  },
});

/**
 * "Cancel request": a returned request, or an approved one before its first day (which gives its
 * paid days or hours back and tells its approvers). Final.
 */
export const cancelTimeOffAction = defineAction({
  access: requireSignedIn(),
  schema: cancelTimeOffInputSchema,
  handler: async (input) => {
    const user = await signedInUser();
    const result = await cancelTimeOff(user, input);
    revalidateTimeOff(user.employee?.id ?? null, result.id);
    return result;
  },
});

/**
 * The request sheet's live summary: the days with their charge, the chargeable days or hours, the
 * paid and unpaid split, and every problem found so far. `hasAttachment` is "1" when the sheet
 * holds a file (or a returned request keeps its own). Writes nothing.
 */
export const previewTimeOffAction = defineAction({
  access: requireSignedIn(),
  schema: z.record(z.string(), z.unknown()).transform((raw) => ({
    ...requestForm.parse(raw),
    hasAttachment: raw.hasAttachment === '1' || raw.hasAttachment === true,
  })),
  handler: async ({ input, attachment, hasAttachment }): Promise<TimeOffPreviewView> =>
    previewTimeOff(await signedInUser(), input, {
      hasAttachment: hasAttachment || attachment !== null,
    }),
});
