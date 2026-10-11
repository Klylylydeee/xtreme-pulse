import { Types } from 'mongoose';
import { withTransaction } from '@pulse/db';
import { ActionError } from '../../actions';
import { normalizeEmail } from '../../account';
import { UserModel } from '../users/model';
import {
  type ApprovalStepSpec,
  DEV_SAMPLE_APPROVAL_RECORD_TYPE,
  DEV_SAMPLE_APPROVAL_TYPE,
  registerCoreApprovalTypes,
} from './registry';
import { submitApproval } from './service';

// Spec: docs/modules/core.md#approvals (decision 109 in docs/BUILD_PLAN.md) — what
// `pnpm dev:approval --requester <email> --step supervisors|board|all:<email,email>|self` runs: a
// `dev.sample` request from the requester, to their supervisors, to any one Board member, to all
// of the listed users, or to a step whose only approver is the requester (which goes to the System
// Administrator). Development only: it refuses in production, where `dev.sample` isn't registered.

export const DEV_SAMPLE_STEP_HELP = 'Use --step supervisors, board, all:<email,email> or self.';

/** The script's `--step` option, parsed. */
export type DevSampleStep =
  | { kind: 'supervisors' }
  | { kind: 'board' }
  | { kind: 'all'; emails: string[] }
  | { kind: 'self' };

/** Reads the `--step` option. Throws {@link ActionError} for anything else. */
export function parseDevSampleStep(value: string): DevSampleStep {
  const option = value.trim();
  if (option === 'supervisors' || option === 'board' || option === 'self') return { kind: option };
  if (option.startsWith('all:')) {
    const emails = option
      .slice('all:'.length)
      .split(',')
      .map((email) => normalizeEmail(email))
      .filter(Boolean);
    if (emails.length > 0) return { kind: 'all', emails: [...new Set(emails)] };
  }
  throw new ActionError(`“${value}” isn’t a step option. ${DEV_SAMPLE_STEP_HELP}`);
}

export interface DevSampleApprovalInput {
  requesterEmail: string;
  /** `supervisors`, `board`, `all:<email,email>` or `self`. */
  step: string;
}

export interface DevSampleApprovalResult {
  requestId: string;
  status: string;
  /** Who was asked to decide, by name and email. Nothing secret. */
  recipients: { name: string; email: string }[];
  /** True when the step went to the System Administrator. */
  routedToSystemAdministrator: boolean;
}

/** The user id for each email, in order, or a refusal naming the unknown ones. */
async function userIdsFor(emails: readonly string[]): Promise<Types.ObjectId[]> {
  const users = await UserModel.find({ email: { $in: emails } }, { email: 1 }).lean();
  const byEmail = new Map(users.map((user) => [user.email, user._id]));
  const missing = emails.filter((email) => !byEmail.has(email));
  if (missing.length > 0) throw new ActionError(`No user has the email ${missing.join(', ')}.`);
  return emails.flatMap((email) => {
    const id = byEmail.get(email);
    return id ? [id] : [];
  });
}

/**
 * Submits a `dev.sample` request from `requesterEmail` with one step built from `step`, in its own
 * transaction. Refuses in production.
 */
export async function submitDevSampleApproval(
  input: DevSampleApprovalInput,
): Promise<DevSampleApprovalResult> {
  if (process.env.NODE_ENV === 'production') {
    throw new ActionError('The sample approval runs in development only.');
  }
  registerCoreApprovalTypes();
  const option = parseDevSampleStep(input.step);
  const email = normalizeEmail(input.requesterEmail);
  const [requesterId] = await userIdsFor([email]);
  if (!requesterId) throw new ActionError(`No user has the email ${email}.`);

  let step: ApprovalStepSpec;
  switch (option.kind) {
    case 'supervisors':
      step = { kind: 'reportingTo', label: 'Supervisor' };
      break;
    case 'board':
      step = { kind: 'anyOf', label: 'Board of Directors', approvers: { set: 'board' } };
      break;
    case 'all':
      step = {
        kind: 'allOf',
        label: 'All listed',
        approvers: { userIds: await userIdsFor(option.emails) },
      };
      break;
    case 'self':
      step = { kind: 'anyOf', label: 'Requester only', approvers: { userIds: [requesterId] } };
      break;
  }

  const recordId = new Types.ObjectId();
  const submitted = await withTransaction((session) =>
    submitApproval(
      {
        type: DEV_SAMPLE_APPROVAL_TYPE,
        record: {
          type: DEV_SAMPLE_APPROVAL_RECORD_TYPE,
          id: recordId,
          label: `Sample ${recordId.toHexString().slice(-6)}`,
        },
        title: `Sample request (${option.kind})`,
        summary: 'A development sample. Approving, returning or rejecting it changes nothing else.',
        href: '/approvals',
        requesterUserId: requesterId,
        steps: [step],
      },
      { session },
    ),
  );

  const approverIds = submitted.pendingApprovers.map(
    (approver) => new Types.ObjectId(approver.userId),
  );
  const users = await UserModel.find({ _id: { $in: approverIds } }, { email: 1 }).lean();
  const emailById = new Map(users.map((user) => [user._id.toHexString(), user.email]));
  return {
    requestId: submitted.id,
    status: submitted.status,
    recipients: submitted.pendingApprovers.map((approver) => ({
      name: approver.name,
      email: emailById.get(approver.userId) ?? '',
    })),
    routedToSystemAdministrator: submitted.routedToSystemAdministrator,
  };
}
