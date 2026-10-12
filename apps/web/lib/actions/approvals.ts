'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { decideApprovalSchema, defineAction } from '@pulse/core';
import {
  decideApproval,
  getApproval,
  listApprovalsDecided,
  listApprovalsWaiting,
  registerCoreApprovalTypes,
} from '@pulse/core/server';
import { registerTalentApprovalSigner } from '@pulse/talent/server';
import { requireSignedIn, signedInUser } from '@/lib/auth';

// Spec: docs/modules/core.md#approvals and #approvals-list — the Approvals list at `/approvals`, a
// Pulse Core page open to every signed-in user (SECURITY.md#rules), so each action checks only
// that someone is signed in (`requireSignedIn`). The approvals services check the person: reading
// a request needs one of its approvers, its requester or a System Administrator; deciding needs a
// named approver of the pending step, with the version the inspector loaded. Deciding is
// audit-logged by the service in its transaction; reading is not.
//
// Every action registers Core's approval types first (`registerCoreApprovalTypes`, safe to call on
// every request), so the engine knows the types it reads and decides. Modules add their own
// registration beside it in their own steps. From step 2.2 deciding also registers Talent's
// e-signature signer (`registerTalentApprovalSigner`): an approve applies the approver's own current
// signature in the decision's transaction, and with no signer registered every approve is refused.

/** The Approvals list's segments: Waiting for you, and Decided. */
const viewSchema = z.enum(['waiting', 'decided'], { error: 'Reload the page and try again.' });

/** One page of a segment after `cursor`, for "Load more". Newest first, keyset paged. */
export const listApprovalsAction = defineAction({
  access: requireSignedIn(),
  schema: z.object({
    view: viewSchema,
    cursor: z.string().max(200).nullish(),
  }),
  handler: async ({ view, cursor }) => {
    registerCoreApprovalTypes();
    const user = await signedInUser();
    const list = view === 'waiting' ? listApprovalsWaiting : listApprovalsDecided;
    return list(user, { cursor: cursor ?? null });
  },
});

/**
 * One request for the inspector, or null when it doesn't exist or the user may not read it (the
 * same answer, so ids can't be probed). Any string: the id may come from a hand-edited
 * `?request=` link, and the service returns null for one that isn't an ObjectId.
 */
export const getApprovalAction = defineAction({
  access: requireSignedIn(),
  schema: z.object({ id: z.string().max(100) }),
  handler: async ({ id }) => {
    registerCoreApprovalTypes();
    return getApproval(await signedInUser(), id);
  },
});

/**
 * Approves, returns or rejects a request as the signed-in user. Remarks are required for a return
 * or a rejection (an inline field error otherwise); a decision on a request that changed since the
 * inspector loaded it, or that someone else already settled, is refused with a message. The
 * sidebar's "waiting" count changes with it, so the whole signed-in area is refreshed.
 */
export const decideApprovalAction = defineAction({
  access: requireSignedIn(),
  schema: decideApprovalSchema,
  handler: async ({ requestId, decision, remarks, version }) => {
    registerCoreApprovalTypes();
    registerTalentApprovalSigner();
    const user = await signedInUser();
    const result = await decideApproval(
      { id: user.id, email: user.email, isSystemAdministrator: user.isSystemAdministrator },
      requestId,
      {
        decision,
        remarks,
        version,
      },
    );
    revalidatePath('/', 'layout');
    return result;
  },
});
