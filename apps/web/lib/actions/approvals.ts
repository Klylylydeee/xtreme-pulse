'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { decideApprovalSchema, defineAction } from '@pulse/core';
import {
  type ApprovalDetail,
  type CurrentUser,
  decideApproval,
  getApproval,
  listApprovalsDecided,
  listApprovalsWaiting,
} from '@pulse/core/server';
import { changeRequestApprovalNotice, E_SIGNATURE_NEEDED_NOTICE } from '@pulse/talent';
import {
  CHANGE_REQUEST_TYPE,
  getChangeRequestView,
  getESignatureStatus,
} from '@pulse/talent/server';
import { registerApprovalTypes } from '@/lib/approval-types';
import { requireSignedIn, signedInUser } from '@/lib/auth';

// Spec: docs/modules/core.md#approvals and #approvals-list — the Approvals list at `/approvals`, a
// Pulse Core page open to every signed-in user (SECURITY.md#rules), so each action checks only
// that someone is signed in (`requireSignedIn`). The approvals services check the person: reading
// a request needs one of its approvers, its requester or a System Administrator; deciding needs a
// named approver of the pending step, with the version the inspector loaded. Deciding is
// audit-logged by the service in its transaction; reading is not.
//
// Every action registers the approval types first (`registerApprovalTypes` in
// lib/approval-types.ts, safe to call on every request), so the engine knows the types it reads
// and decides: Core's, Talent's e-signature signer (step 2.2: an approve applies the approver's own
// current signature in the decision's transaction, and with no signer registered every approve is
// refused) and, from step 2.6, Talent's `talent.changeRequest`, whose hook applies an approved
// change.
//
// Step 2.6 (docs/modules/talent.md#onboarding-checklist-and-change-requests-build-step-26,
// decisions 264 and 271): the inspector's request also carries
// - `approveGate`: for a viewer who may approve but has an employee and no e-signature, the notice
//   "Approving needs your e-signature. Upload it in My record." (Approve is disabled; Return and
//   Reject stay). The server refuses such an approve anyway (the gate in `applyESignature`). The
//   bootstrap system account has no employee and is exempt.
// - `changeRequestNotice`: on a change request the viewer may approve, "Approving applies the
//   change to <name>'s record" (and "…marks these details verified" for IDs and bank). Names and
//   the section only, never a value; null when the viewer may not open the request page.

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
    registerApprovalTypes();
    const user = await signedInUser();
    const list = view === 'waiting' ? listApprovalsWaiting : listApprovalsDecided;
    return list(user, { cursor: cursor ?? null });
  },
});

/** The inspector's request, with step 2.6's gate notice and change request line. */
export type ApprovalInspectorDetail = ApprovalDetail & {
  /** Approve is disabled with this notice, linking to `href` (My record). */
  approveGate: { notice: string; href: string } | null;
  changeRequestNotice: string | null;
};

const MY_RECORD_HREF = '/talent/me';

/** True when `user` has an employee with no e-signature on file (the gate refuses an approve). */
async function missingESignature(user: CurrentUser): Promise<boolean> {
  if (!user.employee) return false;
  const status = await getESignatureStatus(user, user.employee.id);
  return status.version === null;
}

/** The change request line, or null when the viewer may not open the request (no names leak). */
async function changeRequestNoticeFor(
  user: CurrentUser,
  changeRequestId: string,
): Promise<string | null> {
  try {
    const request = await getChangeRequestView(user, changeRequestId);
    if (!request) return null;
    return changeRequestApprovalNotice(request.employee.name, request.section);
  } catch {
    // The no-access state (for example a Board approver whose employee has left HR): no line.
    return null;
  }
}

/**
 * One request for the inspector, or null when it doesn't exist or the user may not read it (the
 * same answer, so ids can't be probed). Any string: the id may come from a hand-edited
 * `?request=` link, and the service returns null for one that isn't an ObjectId.
 */
export const getApprovalAction = defineAction({
  access: requireSignedIn(),
  schema: z.object({ id: z.string().max(100) }),
  handler: async ({ id }): Promise<ApprovalInspectorDetail | null> => {
    registerApprovalTypes();
    const user = await signedInUser();
    const detail = await getApproval(user, id);
    if (!detail) return null;
    const mayApprove = detail.allowedDecisions.includes('approve');
    const [gated, changeRequestNotice] = await Promise.all([
      mayApprove ? missingESignature(user) : false,
      mayApprove && detail.type === CHANGE_REQUEST_TYPE
        ? changeRequestNoticeFor(user, detail.record.id)
        : null,
    ]);
    return {
      ...detail,
      approveGate: gated ? { notice: E_SIGNATURE_NEEDED_NOTICE, href: MY_RECORD_HREF } : null,
      changeRequestNotice,
    };
  },
});

/**
 * Approves, returns or rejects a request as the signed-in user. Remarks are required for a return
 * or a rejection (an inline field error otherwise); a decision on a request that changed since the
 * inspector loaded it, or that someone else already settled, is refused with a message. An approve
 * by someone with no e-signature is refused by the gate, and a change request's hook re-checks the
 * approver's role, each rolling the decision back with its message. The sidebar's "waiting" count
 * changes with it, so the whole signed-in area is refreshed.
 */
export const decideApprovalAction = defineAction({
  access: requireSignedIn(),
  schema: decideApprovalSchema,
  handler: async ({ requestId, decision, remarks, version }) => {
    registerApprovalTypes();
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
