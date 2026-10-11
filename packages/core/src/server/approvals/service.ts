import type { ClientSession, Types } from 'mongoose';
import { z } from 'zod';
import { connectDb, withTransaction } from '@pulse/db';
import { AccessDeniedError, ActionError } from '../../actions';
import {
  APPROVAL_CHANGED_ELSEWHERE,
  APPROVAL_DECISION_LABELS,
  APPROVAL_PAGE_MAX,
  APPROVAL_SUMMARY_MAX_LENGTH,
  APPROVAL_TITLE_MAX_LENGTH,
  type ApprovalDecision,
  approvalHref,
  type ApprovalStatus,
  type ApprovalStepKind,
  type ApprovalStepRule,
  type ApprovalStepStatus,
  type DecideApprovalInput,
  decideApprovalSchema,
  DECISION_STATUS,
} from '../../approvals';
import { AUDIT_LABEL_MAX_LENGTH, type AuditModule, RECORD_TYPE_PATTERN } from '../../audit';
import { now } from '../../dates';
import { isInternalHref } from '../../notifications';
import { recordAudit } from '../audit/service';
import { snapshotForAudit, snapshotsForAudit } from '../audit/snapshot';
import { inputError } from '../departments/service';
import { auditLabel } from '../master-data-audit';
import { notify } from '../notifications/service';
import { decodeCursor, encodeCursor, type KeysetPosition, pageSize, toObjectId } from '../paging';
import { isDuplicateKeyError } from '../seed/duplicate-key';
import { type ApprovalRequestRecord, ApprovalRequestModel, type ApprovalStepRecord } from './model';
import {
  type ApprovalHookContext,
  type ApprovalRequestSnapshot,
  type ApprovalStepSpec,
  type ApprovalTypeDefinition,
  findApprovalType,
  requireApprovalType,
} from './registry';
import { findActiveUser, loadRequester, routeApprovalSteps, userNames } from './routing';

// Spec: docs/modules/core.md#approvals, #approvals-list and #notifications, SECURITY.md#rules and
// #exceptions-to-module-access, docs/ARCHITECTURE.md#cross-module-integration (decisions 99–108 in
// docs/BUILD_PLAN.md) — the approvals engine.
//
// - `submitApproval()` runs inside the module's own transaction (its session is required), so the
//   request, its audit entry and its notifications commit or roll back with the module's change.
// - `decideApproval()` runs in its own transaction and calls the type's hooks in it, so the module
//   updates and audits its own record together with the decision; a hook that throws rolls back
//   the decision, its audit entry and its notifications.
// - Overlapping decisions: a decision names the `version` its form loaded, and the update matches
//   on it, so of two overlapping decisions exactly one wins and a stale form is refused.
// - The services check the person, never module access: deciding needs a named approver of the
//   pending step; reading needs one of the request's approvers, its requester or a System
//   Administrator.
// - Audit: `core.approvalRequest`, module `core`, labelled `<type label> · <record label>`. Submit
//   is `create`, each decision `update` with its remarks as the reason.
// - Notifications link to the request in the Approvals list and hold only the request's title,
//   its type and step labels, names and remarks: never a sensitive field (modules must not put one
//   in a title).

const RECORD_TYPE = 'core.approvalRequest';

/** Notification events (docs/modules/core.md#approvals). */
export const APPROVAL_REQUESTED_EVENT = 'core.approvalRequested';
export const APPROVAL_SETTLED_EVENT = 'core.approvalSettled';
export const APPROVAL_OUTCOME_EVENTS = {
  approved: 'core.approvalApproved',
  returned: 'core.approvalReturned',
  rejected: 'core.approvalRejected',
} as const satisfies Record<Exclude<ApprovalStatus, 'pending'>, string>;

const PENDING_EXISTS =
  'This record already has a request waiting for approval. Wait for it to be decided first.';
const REQUEST_GONE = 'This request no longer exists. Reload the page.';
const NOT_AN_APPROVER = 'You aren’t an approver of this request.';
const NO_LONGER_WAITING =
  'This request is no longer waiting for you. Reload to see where it stands.';

/** Who decides: the signed-in user (a `CurrentUser` fits). */
export interface ApprovalActor {
  id: string;
  email: string;
  /** A System Administrator may read any request, so may be told they aren't its approver. */
  isSystemAdministrator?: boolean;
}

/** Who reads: the signed-in user (a `CurrentUser` fits). */
export interface ApprovalViewer {
  id: string;
  isSystemAdministrator: boolean;
}

// --- Submitting --------------------------------------------------------------------------------

export interface SubmitApprovalInput {
  /** A registered approval type, `<module>.<name>`. */
  type: string;
  /** The record the request is about. One pending request per record. */
  record: { type: string; id: Types.ObjectId | string; label: string };
  /** Plain text, up to 200 characters. Never a sensitive value: notifications carry it. */
  title: string;
  /** Plain text, up to 1,000 characters. Never a sensitive value. */
  summary?: string | null;
  /** The record's page, a path inside the app. */
  href: string;
  /** The user who submits it. */
  requesterUserId: Types.ObjectId | string;
  /** For a resubmission: the returned or rejected request for the same record. */
  previousRequestId?: Types.ObjectId | string | null;
  /** The steps, when the type doesn't fix them (they depend on the record). */
  steps?: readonly ApprovalStepSpec[];
}

export interface SubmittedApproval {
  id: string;
  /** `pending`, or `approved` when every step was skipped. */
  status: ApprovalStatus;
  currentStep: number;
  /** Who was asked to decide now (empty when every step was skipped). */
  pendingApprovers: { userId: string; name: string }[];
  /** True when the pending step went to the System Administrator. */
  routedToSystemAdministrator: boolean;
}

/** Thrown when a submit's input is invalid: a module's mistake. Names fields, never values. */
export class ApprovalInvalidError extends Error {
  constructor(paths: string[]) {
    super(`The approval request is invalid (${paths.join(', ') || 'input'}). Nothing was saved.`);
    this.name = 'ApprovalInvalidError';
  }
}

const objectIdInput = z.custom<Types.ObjectId | string>(
  (value) => toObjectId(value) !== null,
  'Expected an ObjectId.',
);

const submitSchema = z.object({
  type: z.string(),
  record: z.object({
    type: z.string().max(100).regex(RECORD_TYPE_PATTERN),
    id: objectIdInput,
    label: z.string().trim().min(1).max(AUDIT_LABEL_MAX_LENGTH),
  }),
  title: z.string().trim().min(1).max(APPROVAL_TITLE_MAX_LENGTH),
  summary: z
    .string()
    .trim()
    .max(APPROVAL_SUMMARY_MAX_LENGTH)
    .nullish()
    .transform((value) => value || null),
  href: z.string().refine(isInternalHref),
  requesterUserId: objectIdInput,
  previousRequestId: objectIdInput.nullish(),
});

function labelFor(typeLabel: string, request: Pick<ApprovalRequestRecord, 'record'>): string {
  return auditLabel(typeLabel, request.record.label);
}

function snapshotOf(request: ApprovalRequestRecord): ApprovalRequestSnapshot {
  return {
    id: request._id.toHexString(),
    type: request.type,
    module: request.module,
    record: {
      type: request.record.type,
      id: request.record.id.toHexString(),
      label: request.record.label,
    },
    title: request.title,
    requesterUserId: request.requesterUserId.toHexString(),
    requesterEmployeeId: request.requesterEmployeeId?.toHexString() ?? null,
    status: request.status,
    currentStep: request.currentStep,
    previousRequestId: request.previousRequestId?.toHexString() ?? null,
  };
}

/** Tells a step's approvers it is waiting for them, with the System Administrator hint. */
async function notifyRequested(
  request: ApprovalRequestRecord,
  stepIndex: number,
  definition: Readonly<ApprovalTypeDefinition>,
  session: ClientSession,
): Promise<void> {
  const step = request.steps[stepIndex];
  if (!step) return;
  const base = {
    module: 'core' as const,
    event: APPROVAL_REQUESTED_EVENT,
    title: `Approval needed: ${request.title}`,
    href: approvalHref(request._id.toHexString()),
    record: { type: RECORD_TYPE, id: request._id },
  };
  const body = `${definition.label} · ${step.label}`;
  const asAdministrator = step.approvers.filter((approver) => approver.asSystemAdministrator);
  const others = step.approvers.filter((approver) => !approver.asSystemAdministrator);
  await notify({ ...base, body, recipients: others.map((a) => a.userId) }, { session });
  await notify(
    {
      ...base,
      body: `${body}. Sent to you as System Administrator.`,
      recipients: asAdministrator.map((a) => a.userId),
    },
    { session },
  );
}

/**
 * Submits a request for approval, inside the module's transaction: pass the session of the
 * transaction that makes the module's change. Works out and fixes every step's approvers, skips
 * leading steps the type's `whenEmpty` skipped, and notifies the first pending step's approvers.
 * When every step was skipped the request is stored as approved, and no hook runs: the module
 * acts on the returned status itself.
 *
 * Throws {@link ActionError} for the requester to read (no one to approve, a pending request for
 * the record already), and plain errors for a module's mistakes (an unregistered type, bad input).
 */
export async function submitApproval(
  input: SubmitApprovalInput,
  options: { session: ClientSession },
): Promise<SubmittedApproval> {
  const session = options?.session;
  if (!session) {
    throw new Error('submitApproval runs inside the module’s transaction: pass its session.');
  }
  const definition = requireApprovalType(input.type);
  const parsed = submitSchema.safeParse(input);
  if (!parsed.success) {
    throw new ApprovalInvalidError(
      parsed.error.issues.map((issue) => issue.path.map(String).join('.')),
    );
  }
  const data = parsed.data;
  const steps = input.steps ?? definition.steps;
  if (!steps || steps.length === 0) {
    throw new Error(`The approval type "${input.type}" has no steps; pass them to submitApproval.`);
  }
  const recordId = toObjectId(data.record.id) as Types.ObjectId;

  await connectDb();
  const requester = await loadRequester(data.requesterUserId, session);

  const previousRequestId = data.previousRequestId ? toObjectId(data.previousRequestId) : null;
  if (previousRequestId) {
    const previous = await ApprovalRequestModel.findById(previousRequestId, {
      record: 1,
      status: 1,
    })
      .session(session)
      .lean();
    if (
      !previous ||
      previous.record.type !== data.record.type ||
      !previous.record.id.equals(recordId) ||
      (previous.status !== 'returned' && previous.status !== 'rejected')
    ) {
      throw new Error('A resubmission follows a returned or rejected request for the same record.');
    }
  }

  const pending = await ApprovalRequestModel.exists({
    'record.type': data.record.type,
    'record.id': recordId,
    status: 'pending',
  }).session(session);
  if (pending) throw new ActionError(PENDING_EXISTS);

  const routed = await routeApprovalSteps(steps, definition.whenEmpty, requester, session);
  const first = routed.findIndex((step) => step.status === 'waiting');
  const submittedAt = now();
  const stepRecords: ApprovalStepRecord[] = routed.map((step, index) => ({
    ...step,
    status: index === first ? 'pending' : step.status,
    decisions: [],
  }));
  const pendingApproverIds = (routed[first]?.approvers ?? []).map((approver) => approver.userId);

  let created: ApprovalRequestRecord;
  try {
    const [doc] = await ApprovalRequestModel.create(
      [
        {
          type: input.type,
          module: definition.module,
          record: { type: data.record.type, id: recordId, label: data.record.label },
          title: data.title,
          summary: data.summary,
          href: data.href,
          requesterUserId: requester.userId,
          requesterEmployeeId: requester.employeeId,
          status: first === -1 ? 'approved' : 'pending',
          currentStep: first === -1 ? routed.length - 1 : first,
          previousRequestId,
          submittedAt,
          settledAt: first === -1 ? submittedAt : null,
          settledBy: null,
          version: 0,
          steps: stepRecords,
          pendingApproverIds,
          approverIds: pendingApproverIds,
          decidedFor: [],
          createdBy: requester.userId,
        },
      ],
      { session },
    );
    if (!doc) throw new Error('The approval request wasn’t created.');
    created = doc.toObject() as ApprovalRequestRecord;
  } catch (error) {
    if (isDuplicateKeyError(error, 'record.id')) throw new ActionError(PENDING_EXISTS);
    throw error;
  }

  await recordAudit(
    {
      actorId: requester.userId,
      actorEmail: requester.email,
      module: 'core',
      action: 'create',
      record: { type: RECORD_TYPE, id: created._id, label: labelFor(definition.label, created) },
      before: null,
      after: snapshotForAudit(ApprovalRequestModel, created),
    },
    { session },
  );
  if (first !== -1) await notifyRequested(created, first, definition, session);

  const firstStep = first === -1 ? null : created.steps[first];
  return {
    id: created._id.toHexString(),
    status: created.status,
    currentStep: created.currentStep,
    pendingApprovers: (firstStep?.approvers ?? []).map((approver) => ({
      userId: approver.userId.toHexString(),
      name: approver.nameSnapshot,
    })),
    routedToSystemAdministrator: firstStep?.routedToSystemAdministrator ?? false,
  };
}

// --- Deciding --------------------------------------------------------------------------------

export interface DecidedApproval {
  status: ApprovalStatus;
  currentStep: number;
  version: number;
}

const has = (ids: readonly Types.ObjectId[], id: Types.ObjectId) => ids.some((v) => v.equals(id));
const without = (ids: readonly Types.ObjectId[], drop: readonly Types.ObjectId[]) =>
  ids.filter((id) => !has(drop, id));

const PAST_TENSE = { approve: 'approved', return: 'returned', reject: 'rejected' } as const;

/**
 * Records a decision (approve, return or reject) by `actor` on the request's pending step, in its
 * own transaction, and calls the type's hooks in it. `input.version` is the version the form
 * loaded. Someone who may not read the request gets the same {@link ActionError} as for a missing
 * one (like {@link getApproval}), so ids can't be probed; its requester or a System Administrator
 * who isn't its approver gets {@link AccessDeniedError}. Throws {@link ActionError} for a decision that can't be made now (already settled, stale form, a
 * decision the type doesn't allow, missing remarks).
 */
export async function decideApproval(
  actor: ApprovalActor,
  requestId: string,
  input: Omit<DecideApprovalInput, 'requestId'>,
): Promise<DecidedApproval> {
  const parsed = decideApprovalSchema.safeParse({ ...input, requestId });
  if (!parsed.success) throw inputError(parsed.error.issues);
  const { decision, remarks, version } = parsed.data;
  const actorId = toObjectId(actor.id);
  const id = toObjectId(requestId);
  if (!actorId || !id) throw new ActionError(REQUEST_GONE);

  return withTransaction(async (session) => {
    const before = await ApprovalRequestModel.findById(id)
      .session(session)
      .lean<ApprovalRequestRecord>();
    if (!before) throw new ActionError(REQUEST_GONE);

    // Who may decide: a named approver of the pending step, still active.
    if (before.status !== 'pending' || !has(before.pendingApproverIds, actorId)) {
      if (has(before.approverIds, actorId)) {
        const settler = before.settledBy ? approverName(before, before.settledBy) : null;
        throw new ActionError(
          settler
            ? `${settler} already settled this request. No action is needed from you.`
            : NO_LONGER_WAITING,
        );
      }
      // Only those who may read the request learn it exists (as getApproval).
      if (actor.isSystemAdministrator === true || before.requesterUserId.equals(actorId)) {
        throw new AccessDeniedError(NOT_AN_APPROVER);
      }
      throw new ActionError(REQUEST_GONE);
    }
    if (before.version !== version) throw new ActionError(APPROVAL_CHANGED_ELSEWHERE);
    const self = await findActiveUser(actorId, session);
    if (!self) throw new ActionError('Your account is no longer active, so this wasn’t saved.');

    const definition = requireApprovalType(before.type);
    if (!definition.allowedDecisions.includes(decision)) {
      throw new ActionError(
        `${definition.label} requests can’t be ${PAST_TENSE[decision]}. ${
          definition.allowedDecisions.includes('return') ? 'Return it with remarks instead.' : ''
        }`.trim(),
      );
    }

    const decidedAt = now();
    const steps: ApprovalStepRecord[] = before.steps.map((step) => ({
      ...step,
      approvers: [...step.approvers],
      decisions: [...step.decisions],
    }));
    const stepIndex = before.currentStep;
    const step = steps[stepIndex];
    if (!step) throw new Error('The request’s current step is missing.');
    step.decisions.push({ userId: actorId, decision, remarks, decidedAt });

    let status: ApprovalStatus = 'pending';
    let currentStep = stepIndex;
    let pendingApproverIds = without(before.pendingApproverIds, [actorId]);
    let approverIds = before.approverIds;
    /** Pending approvers who lose the item without deciding: told it was settled. */
    let settledFor: Types.ObjectId[] = [];
    let stepApproved = false;

    if (decision !== 'approve') {
      step.status = DECISION_STATUS[decision];
      status = DECISION_STATUS[decision];
      settledFor = pendingApproverIds;
      pendingApproverIds = [];
    } else {
      if (step.rule === 'all') {
        // A System Administrator filling the requester's place: the first one fills it.
        const entry = step.approvers.find((approver) => approver.userId.equals(actorId));
        if (entry?.asSystemAdministrator) {
          const fillers = step.approvers
            .filter((approver) => approver.asSystemAdministrator)
            .map((approver) => approver.userId);
          settledFor = without(fillers, [actorId]).filter((filler) =>
            has(pendingApproverIds, filler),
          );
          pendingApproverIds = without(pendingApproverIds, fillers);
        }
      } else {
        settledFor = pendingApproverIds;
        pendingApproverIds = [];
      }
      if (pendingApproverIds.length === 0) {
        step.status = 'approved';
        stepApproved = true;
        const next = steps.findIndex((s, index) => index > stepIndex && s.status === 'waiting');
        const nextStep = steps[next];
        if (!nextStep) {
          status = 'approved';
        } else {
          nextStep.status = 'pending';
          currentStep = next;
          pendingApproverIds = nextStep.approvers.map((approver) => approver.userId);
          approverIds = [...approverIds, ...without(pendingApproverIds, approverIds)];
        }
      }
    }

    const settled = status !== 'pending';
    // The Decided list: the decider's part in the step ended, and so did the part of everyone this
    // decision took the item from.
    const decidedFor = [
      ...(before.decidedFor ?? []),
      ...[actorId, ...settledFor].map((userId) => ({ userId, decidedAt })),
    ];
    const result = await ApprovalRequestModel.updateOne(
      { _id: before._id, version: before.version },
      {
        $set: {
          steps,
          status,
          currentStep,
          pendingApproverIds,
          approverIds,
          decidedFor,
          settledAt: settled ? decidedAt : null,
          settledBy: settled ? actorId : null,
          updatedBy: actorId,
        },
        $inc: { version: 1 },
      },
      { session, runValidators: true },
    );
    if (result.matchedCount !== 1) throw new ActionError(APPROVAL_CHANGED_ELSEWHERE);
    const after = await ApprovalRequestModel.findById(before._id)
      .session(session)
      .lean<ApprovalRequestRecord>()
      .orFail();

    await recordAudit(
      {
        actorId,
        actorEmail: actor.email,
        module: 'core',
        action: 'update',
        record: { type: RECORD_TYPE, id: after._id, label: labelFor(definition.label, after) },
        ...snapshotsForAudit(ApprovalRequestModel, before, after),
        reason: remarks,
      },
      { session },
    );

    // The module's hooks, in this transaction.
    const context: ApprovalHookContext = {
      request: snapshotOf(after),
      decision: { userId: actor.id, email: actor.email, decision, remarks },
      session,
    };
    if (stepApproved && definition.onStepApproved) {
      await definition.onStepApproved({ ...context, stepIndex, stepLabel: step.label });
    }
    if (settled) await definition.onSettled(context);

    // Notifications, in this transaction.
    const actorName = approverName(after, actorId) ?? self.name;
    const href = approvalHref(after._id.toHexString());
    const ref = { type: RECORD_TYPE, id: after._id };
    await notify(
      {
        recipients: settledFor,
        module: 'core',
        event: APPROVAL_SETTLED_EVENT,
        title: `Settled by ${actorName}, no action needed`,
        body: `${definition.label}: ${after.title}`,
        href,
        record: ref,
      },
      { session },
    );
    if (!settled && currentStep !== stepIndex) {
      await notifyRequested(after, currentStep, definition, session);
    }
    if (settled) {
      const recipients = definition.outcomeRecipients
        ? await definition.outcomeRecipients(context)
        : [after.requesterUserId];
      const outcome = status as Exclude<ApprovalStatus, 'pending'>;
      await notify(
        {
          recipients,
          module: 'core',
          event: APPROVAL_OUTCOME_EVENTS[outcome],
          title: `${APPROVAL_STATUS_TITLES[outcome]}: ${after.title}`,
          body: remarks
            ? `${actorName} ${PAST_TENSE[decision]} it. Remarks: ${remarks}`
            : `${actorName} ${PAST_TENSE[decision]} it.`,
          href,
          record: ref,
        },
        { session },
      );
    }

    return { status: after.status, currentStep: after.currentStep, version: after.version };
  });
}

const APPROVAL_STATUS_TITLES = {
  approved: 'Approved',
  returned: 'Returned',
  rejected: 'Rejected',
} as const;

/** The name an approver had at submit, from any step of the request. */
function approverName(request: ApprovalRequestRecord, userId: Types.ObjectId): string | null {
  for (const step of request.steps) {
    const found = step.approvers.find((approver) => approver.userId.equals(userId));
    if (found) return found.nameSnapshot;
  }
  return null;
}

// --- Reading ---------------------------------------------------------------------------------

/** One row of the Approvals list. Plain values only; nothing sensitive. */
export interface ApprovalRow {
  id: string;
  type: string;
  /** The type's label, or its name when it isn't registered in this process. */
  typeLabel: string;
  module: AuditModule;
  record: { type: string; id: string; label: string };
  title: string;
  summary: string | null;
  /** The record's page. */
  href: string;
  requester: { userId: string; name: string };
  status: ApprovalStatus;
  submittedAt: Date;
  settledAt: Date | null;
  /** The pending step, or the step that settled the request. */
  step: { index: number; label: string; rule: ApprovalStepRule; status: ApprovalStepStatus };
  /** An all-of step's progress ("1 of 2 approved"); null for an any-one step. */
  progress: { approved: number; required: number } | null;
  /** The viewer was asked at the pending step as a System Administrator. */
  sentToYouAsSystemAdministrator: boolean;
  /** Send back with a decision. */
  version: number;
}

export interface ApprovalStepView {
  index: number;
  kind: ApprovalStepKind;
  label: string;
  rule: ApprovalStepRule;
  status: ApprovalStepStatus;
  routedToSystemAdministrator: boolean;
  approvers: {
    userId: string;
    name: string;
    asSystemAdministrator: boolean;
    decision: { decision: ApprovalDecision; remarks: string | null; decidedAt: Date } | null;
  }[];
}

/** A request in the inspector. */
export interface ApprovalDetail extends ApprovalRow {
  previousRequestId: string | null;
  settledBy: { userId: string; name: string } | null;
  steps: ApprovalStepView[];
  /** What the viewer may do now: empty unless they are a pending approver of a pending request. */
  allowedDecisions: ApprovalDecision[];
  /** The decisions' button labels, in `allowedDecisions` order. */
  decisionLabels: string[];
}

export interface ApprovalPage {
  rows: ApprovalRow[];
  /** Pass back as `cursor` for the next page; null on the last page. */
  nextCursor: string | null;
}

export interface ListApprovalsOptions {
  cursor?: string | null;
  /** 20 by default, at most APPROVAL_PAGE_MAX. */
  limit?: number;
}

function progressOf(step: ApprovalStepRecord): ApprovalRow['progress'] {
  if (step.rule !== 'all') return null;
  const members = step.approvers.filter((approver) => !approver.asSystemAdministrator).length;
  const filled = step.approvers.some((approver) => approver.asSystemAdministrator) ? 1 : 0;
  const approved = new Set(
    step.decisions
      .filter((decision) => decision.decision === 'approve')
      .map((decision) => decision.userId.toHexString()),
  ).size;
  return { approved, required: members + filled };
}

function toRow(
  request: ApprovalRequestRecord,
  viewerId: Types.ObjectId | null,
  names: Map<string, string>,
): ApprovalRow {
  const step = request.steps[request.currentStep] ?? request.steps.at(-1);
  if (!step) throw new Error('An approval request has no steps.');
  const requesterId = request.requesterUserId.toHexString();
  const viewerEntry =
    viewerId && request.status === 'pending'
      ? step.approvers.find((approver) => approver.userId.equals(viewerId))
      : undefined;
  return {
    id: request._id.toHexString(),
    type: request.type,
    typeLabel: findApprovalType(request.type)?.label ?? request.type,
    module: request.module,
    record: {
      type: request.record.type,
      id: request.record.id.toHexString(),
      label: request.record.label,
    },
    title: request.title,
    summary: request.summary ?? null,
    href: request.href,
    requester: { userId: requesterId, name: names.get(requesterId) ?? 'Unknown user' },
    status: request.status,
    submittedAt: request.submittedAt,
    settledAt: request.settledAt ?? null,
    step: { index: request.currentStep, label: step.label, rule: step.rule, status: step.status },
    progress: progressOf(step),
    sentToYouAsSystemAdministrator: viewerEntry?.asSystemAdministrator === true,
    version: request.version,
  };
}

function toDetail(
  request: ApprovalRequestRecord,
  viewerId: Types.ObjectId | null,
  names: Map<string, string>,
): ApprovalDetail {
  const row = toRow(request, viewerId, names);
  const canDecide =
    viewerId !== null && request.status === 'pending' && has(request.pendingApproverIds, viewerId);
  const allowedDecisions = canDecide
    ? [...(findApprovalType(request.type)?.allowedDecisions ?? [])]
    : [];
  return {
    ...row,
    previousRequestId: request.previousRequestId?.toHexString() ?? null,
    settledBy: request.settledBy
      ? {
          userId: request.settledBy.toHexString(),
          name:
            approverName(request, request.settledBy) ??
            names.get(request.settledBy.toHexString()) ??
            'Unknown user',
        }
      : null,
    steps: request.steps.map((step, index) => ({
      index,
      kind: step.kind,
      label: step.label,
      rule: step.rule,
      status: step.status,
      routedToSystemAdministrator: step.routedToSystemAdministrator,
      approvers: step.approvers.map((approver) => {
        const decided = step.decisions.find((d) => d.userId.equals(approver.userId));
        return {
          userId: approver.userId.toHexString(),
          name: approver.nameSnapshot,
          asSystemAdministrator: approver.asSystemAdministrator,
          decision: decided
            ? { decision: decided.decision, remarks: decided.remarks, decidedAt: decided.decidedAt }
            : null,
        };
      }),
    })),
    allowedDecisions,
    decisionLabels: allowedDecisions.map((decision) => APPROVAL_DECISION_LABELS[decision]),
  };
}

async function requesterNames(requests: readonly ApprovalRequestRecord[]) {
  const ids = new Map(requests.map((r) => [r.requesterUserId.toHexString(), r.requesterUserId]));
  return userNames([...ids.values()]);
}

/** The filter for rows after `position`, in `{ submittedAt: -1, _id: -1 }` order. */
function afterSubmitted(position: KeysetPosition): Record<string, unknown> {
  return {
    $or: [
      { submittedAt: { $lt: position.createdAt } },
      { submittedAt: position.createdAt, _id: { $lt: position.id } },
    ],
  };
}

async function listPage(
  viewerId: Types.ObjectId,
  filter: Record<string, unknown>,
  { cursor, limit }: ListApprovalsOptions,
): Promise<ApprovalPage> {
  const size = pageSize(limit, 20, APPROVAL_PAGE_MAX);
  const conditions = [filter];
  if (cursor) conditions.push(afterSubmitted(decodeCursor(cursor)));
  await connectDb();
  const found = await ApprovalRequestModel.find({ $and: conditions })
    .sort({ submittedAt: -1, _id: -1 })
    .limit(size + 1)
    .lean<ApprovalRequestRecord[]>();
  const page = found.slice(0, size);
  const names = await requesterNames(page);
  const last = page.at(-1);
  return {
    rows: page.map((request) => toRow(request, viewerId, names)),
    nextCursor:
      found.length > size && last
        ? encodeCursor({ createdAt: last.submittedAt, _id: last._id })
        : null,
  };
}

/** Waiting for you: pending requests whose pending step names the viewer, newest first. */
export async function listApprovalsWaiting(
  viewer: Pick<ApprovalViewer, 'id'>,
  options: ListApprovalsOptions = {},
): Promise<ApprovalPage> {
  const viewerId = toObjectId(viewer.id);
  if (!viewerId) return { rows: [], nextCursor: null };
  return listPage(viewerId, { status: 'pending', pendingApproverIds: viewerId }, options);
}

/**
 * Decided: requests where the viewer's part in a step has ended (they decided it, another approver
 * or System Administrator settled it for them, or the request ended), whatever the request's status,
 * so also while a later step is pending. Newest first by when the viewer's part last ended
 * (their latest `decidedFor` entry), then by id.
 *
 * The match uses the `decidedFor.userId` index; the order is per viewer, so it is computed and
 * sorted after the match (a multikey index can't sort by the matching entry alone).
 */
export async function listApprovalsDecided(
  viewer: Pick<ApprovalViewer, 'id'>,
  { cursor, limit }: ListApprovalsOptions = {},
): Promise<ApprovalPage> {
  const viewerId = toObjectId(viewer.id);
  if (!viewerId) return { rows: [], nextCursor: null };
  const size = pageSize(limit, 20, APPROVAL_PAGE_MAX);
  const position = cursor ? decodeCursor(cursor) : null;
  await connectDb();
  const found = await ApprovalRequestModel.aggregate<
    ApprovalRequestRecord & { viewerDecidedAt: Date }
  >([
    { $match: { 'decidedFor.userId': viewerId } },
    {
      $addFields: {
        viewerDecidedAt: {
          $max: {
            $map: {
              input: {
                $filter: { input: '$decidedFor', cond: { $eq: ['$$this.userId', viewerId] } },
              },
              in: '$$this.decidedAt',
            },
          },
        },
      },
    },
    ...(position
      ? [
          {
            $match: {
              $or: [
                { viewerDecidedAt: { $lt: position.createdAt } },
                { viewerDecidedAt: position.createdAt, _id: { $lt: position.id } },
              ],
            },
          },
        ]
      : []),
    { $sort: { viewerDecidedAt: -1, _id: -1 } },
    { $limit: size + 1 },
  ]);
  const page = found.slice(0, size);
  const names = await requesterNames(page);
  const last = page.at(-1);
  return {
    rows: page.map((request) => toRow(request, viewerId, names)),
    nextCursor:
      found.length > size && last
        ? encodeCursor({ createdAt: last.viewerDecidedAt, _id: last._id })
        : null,
  };
}

/** How many requests are waiting for the user (the sidebar badge). */
export async function countApprovalsWaiting(userId: string): Promise<number> {
  const id = toObjectId(userId);
  if (!id) return 0;
  await connectDb();
  return ApprovalRequestModel.countDocuments({ status: 'pending', pendingApproverIds: id });
}

/** True when the viewer may read the request: an approver, its requester or a System Administrator. */
function canRead(request: ApprovalRequestRecord, viewer: ApprovalViewer, viewerId: Types.ObjectId) {
  return (
    viewer.isSystemAdministrator ||
    request.requesterUserId.equals(viewerId) ||
    has(request.approverIds, viewerId)
  );
}

/**
 * One request for the inspector, or null when it doesn't exist or the viewer may not read it
 * (the same answer, so ids can't be probed).
 */
export async function getApproval(
  viewer: ApprovalViewer,
  requestId: string,
): Promise<ApprovalDetail | null> {
  const viewerId = toObjectId(viewer.id);
  const id = toObjectId(requestId);
  if (!viewerId || !id) return null;
  await connectDb();
  const request = await ApprovalRequestModel.findById(id).lean<ApprovalRequestRecord>();
  if (!request || !canRead(request, viewer, viewerId)) return null;
  return toDetail(request, viewerId, await requesterNames([request]));
}

/**
 * Every request for a record, newest first, for the module's record page. The caller has checked
 * that the viewer may open the record (module access or {@link assertApproverCanView}).
 */
export async function listApprovalsForRecord(
  viewer: Pick<ApprovalViewer, 'id'>,
  recordType: string,
  recordId: string,
): Promise<ApprovalDetail[]> {
  const id = toObjectId(recordId);
  if (!id || !RECORD_TYPE_PATTERN.test(recordType)) return [];
  await connectDb();
  const requests = await ApprovalRequestModel.find({ 'record.type': recordType, 'record.id': id })
    .sort({ submittedAt: -1, _id: -1 })
    .limit(100)
    .lean<ApprovalRequestRecord[]>();
  const names = await requesterNames(requests);
  const viewerId = toObjectId(viewer.id);
  return requests.map((request) => toDetail(request, viewerId, names));
}

/**
 * True when the user is or was an approver on any request for the record, while it is pending and
 * afterwards (SECURITY.md#exceptions-to-module-access). Only steps that became pending count.
 */
export async function isApproverFor(
  userId: string,
  recordType: string,
  recordId: string,
): Promise<boolean> {
  const user = toObjectId(userId);
  const id = toObjectId(recordId);
  if (!user || !id || !RECORD_TYPE_PATTERN.test(recordType)) return false;
  await connectDb();
  const found = await ApprovalRequestModel.exists({
    'record.type': recordType,
    'record.id': id,
    approverIds: user,
  });
  return found !== null;
}

/**
 * The read-only approver exception for a module's record page: passes a System Administrator or
 * anyone {@link isApproverFor} the record, and throws {@link AccessDeniedError} for anyone else.
 * Modules call it beside their module access check.
 */
export async function assertApproverCanView(
  viewer: ApprovalViewer,
  recordType: string,
  recordId: string,
): Promise<void> {
  if (viewer.isSystemAdministrator) return;
  if (await isApproverFor(viewer.id, recordType, recordId)) return;
  throw new AccessDeniedError();
}
