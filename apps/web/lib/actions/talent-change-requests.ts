'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { defineAction } from '@pulse/core';
import {
  cancelChangeRequestSchema,
  changeRequestIdField,
  changeRequestNoteField,
} from '@pulse/talent';
import { cancelChangeRequest, resendChangeRequest } from '@pulse/talent/server';
import { requireSignedIn, signedInUser } from '@/lib/auth';

// Spec: docs/modules/talent.md#onboarding-checklist-and-change-requests-build-step-26 ("Change
// requests"; decision 272 in docs/BUILD_PLAN.md) and SECURITY.md#exceptions-to-module-access —
// the employee's own returned change requests on /talent/me: "Edit and send again" and "Cancel
// request". Self-service: a signed-in user, no module access. The services take the request's id
// only and refuse anyone else's request as not found, reload the actor in their transaction, check
// the request is still returned, and write the `update` entry on `talent.changeRequest`. Deciding a
// request stays on Approvals.
//
// Nothing here is logged or cached, and nothing comes back but the request's id and status: no
// proposed or stored value.

/** After a change: the own record and its Change requests list, and the request's page. */
function revalidateRequest(changeRequestId: string) {
  revalidatePath('/talent/me');
  revalidatePath('/talent/onboarding');
  revalidatePath(`/talent/change-requests/${changeRequestId}`);
}

/**
 * "Edit and send again" on a returned request. The form sends the on-screen section's fields
 * beside `changeRequestId` and `note`; the service takes only this request's section from them,
 * compared with the record as it is now, and routes the new approval for the employee as they are
 * now.
 */
export const resendChangeRequestAction = defineAction({
  access: requireSignedIn(),
  schema: z
    .object({ changeRequestId: changeRequestIdField, note: changeRequestNoteField.optional() })
    .catchall(z.unknown()),
  handler: async ({ changeRequestId, note, ...values }) => {
    const result = await resendChangeRequest(await signedInUser(), {
      changeRequestId,
      note,
      values,
    });
    revalidateRequest(result.id);
    return result;
  },
});

/** "Cancel request" on a returned request: final, never deleted. */
export const cancelChangeRequestAction = defineAction({
  access: requireSignedIn(),
  schema: cancelChangeRequestSchema,
  handler: async (input) => {
    const result = await cancelChangeRequest(await signedInUser(), input);
    revalidateRequest(result.id);
    return result;
  },
});
