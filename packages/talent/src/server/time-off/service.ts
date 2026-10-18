import { type ClientSession, Types } from 'mongoose';
import { connectDb, withTransaction } from '@pulse/db';
import {
  AccessDeniedError,
  ActionError,
  approvalHref,
  type BusinessDate,
  businessToday,
  now,
} from '@pulse/core';
import {
  type ApprovalDetail,
  type EmployeeIdentity,
  getEmployeeIdentity,
  isApproverFor,
  isSystemAdministrator,
  listApprovalsForRecord,
  nextDocumentNumber,
  notify,
  recordAudit,
  type ReloadedActor,
  reloadActorAccess,
  saveUpload,
  snapshotForAudit,
  snapshotsForAudit,
  submitApproval,
  toDirectoryIdentity,
} from '@pulse/core/server';
import {
  assertOnboardingGate,
  checkOnboardingGate,
  onboardingGateMessage,
} from '../../onboarding/gates';
import type { OffsetAvailableBalanceView } from '../../offset/views';
import type { TimeOffRequestDay } from '../../time-off/days';
import {
  TIME_OFF_APPROVAL_TYPES,
  TIME_OFF_CANCELLED_EVENT,
  TIME_OFF_NUMBER_PREFIXES,
  TIME_OFF_REQUEST_TYPE,
  timeOffRequestHref,
} from '../../time-off/kinds';
import {
  canCancelTimeOff,
  leaveFilingWindowText,
  TIME_OFF_CANCEL_STARTED_MESSAGE,
  timeOffProblemMessage,
} from '../../time-off/rules';
import {
  type CancelTimeOffInput,
  cancelTimeOffInputSchema,
  type TimeOffRequestInput,
  timeOffRequestInputSchema,
} from '../../time-off/schemas';
import {
  type LeaveAttachment,
  type LeaveBalanceKind,
  type LeaveCountDays,
  type LeaveSettings,
  leaveTypeOf,
} from '../../time-off/settings';
import {
  CONFIDENTIAL_LEAVE_LABEL,
  type LeaveBalancesView,
  leaveApprovalSummary,
  leaveApprovalTitle,
  leaveTypeNameLabel,
  leaveTypeShortLabel,
  offsetApprovalSummary,
  offsetApprovalTitle,
  type TimeOffPreviewView,
  type TimeOffRequestView,
  timeOffCancelledMessage,
} from '../../time-off/views';
import { inputError } from '../input';
import {
  canSeeConfidentialFor,
  getLeaveBalances,
  timeOffViewerIdentity,
  writeLeaveUsage,
} from '../leave/service';
import { getOffsetBalance, writeOffsetUsage } from '../offset/service';
import { leaveSettingsOn } from '../payroll-settings/settings';
import { canOpenTimeOffAttachment, NO_EMPLOYEE_TIME_OFF, type TalentActor } from '../policy';
import { dayOf, EMPLOYEE_GONE, fileUrlOf, instantOf, objectIdOf, sentFile } from '../shared';
import { serviceIdentity } from '../timesheets/access';
import { onboardingGateStatus } from '../timesheets/submission';
import {
  isHrRequester,
  registerTimeOffApprovalTypes,
  timeOffApprovalSteps,
  timeOffAuditLabel,
} from './approval';
import {
  type CheckedTimeOff,
  checkTimeOffRequest,
  LEAVE_TYPE_NO_ATTACHMENT,
  LEAVE_TYPE_UNKNOWN,
  OFFSET_NO_ATTACHMENT,
  TimeOffRefusedError,
} from './checks';
import { loadTimeOffContext, spanOf, storedRequestDays, typeOfRequest } from './days';
import { ensureTimeOffLock, touchTimeOffLock } from './lock';
import { type TimeOffRequestDocument, TimeOffRequestModel } from './model';

// Spec: docs/modules/talent.md#leave-offset-time-off-and-opening-balances-build-step-28 ("Time off
// requests", "Filing a leave request", "Insufficient balance", "Filing offset time off",
// "Approval", "Who may see what", "Screens"), SECURITY.md#exceptions-to-module-access ("The own
// time off and the team's") and decisions 309–314 and 317–319 in docs/BUILD_PLAN.md.
//
// - Self-service: filing, editing and sending again, and cancelling act on the signed-in user's
//   own employee, read from the database in the transaction; no employee id is taken from the
//   request, and another person's request is simply not found. No module access is needed.
// - Filing, in one transaction after the employee's lock (./lock.ts), so two overlapping requests
//   can't both be saved: the account is active, the onboarding gate `fileTimeRequest` passes, and
//   every rule of ./checks.ts holds; then the number (`LV-`/`OFS-YYYY-NNNN`), the request with its
//   preview split, the Core approval request (one step passed at submit, ./approval.ts) and a
//   `create` entry on `talent.timeOffRequest` labelled with the number.
// - The attachment (a type that asks for one) is saved before the transaction, images re-encoded
//   (the receipt transform), under the upload settings; a filing that fails leaves it unused, and
//   it never opens (the file route requires the request to point at it). When a file is sent, the
//   checks run once before the upload too, so an ordinary refusal stores nothing.
// - Edit and send again: a returned request only, the same kind, every rule checked again (the
//   filing window included, HANDOFF item 158), a new approval request with `previousRequestId`,
//   and an `update` entry. A pending request can't be withdrawn.
// - Cancel: a returned request, or an approved one before its first day (the paid half days or
//   minutes come back with a `usage` entry, and its approvers get `talent.timeOffCancelled`); an
//   `update` entry.
// - Reads: the own page, someone's page (read-only, `timeOffViewerIdentity`), a request page, and
//   the request sheet's preview. A confidential type reads "Leave", with no type, attachment or
//   reason, to anyone but the employee, HR and the System Administrator.

export const TIME_OFF_REQUEST_GONE = 'This request can’t be found. Reload to see it.';
export const TIME_OFF_NOT_RETURNED =
  'Only a returned request can be edited and sent again. Reload to see where it stands.';
export const TIME_OFF_NOT_CANCELLABLE =
  'Only a returned request, or an approved one before its first day, can be cancelled. Reload to see where it stands.';
export const TIME_OFF_KIND_FIXED =
  'A returned request keeps its kind. Cancel it and file the other kind instead.';
export const TIME_OFF_ACCOUNT_INACTIVE =
  'Your account is no longer active, so time off can’t be filed.';
export const TIME_OFF_REQUEST_DENIED = 'You don’t have access to this request.';

/** Who filed or changes the request: the signed-in user and their own employee, as they are now. */
interface OwnContext {
  current: ReloadedActor;
  identity: EmployeeIdentity;
}

function assertHasEmployee(actor: TalentActor): string {
  const id = actor.employee?.id;
  if (!id) throw new AccessDeniedError(NO_EMPLOYEE_TIME_OFF);
  return id;
}

async function ownContext(actor: TalentActor, session: ClientSession): Promise<OwnContext> {
  const ownId = assertHasEmployee(actor);
  const current = await reloadActorAccess({ id: actor.id }, session);
  if (!current.employee || current.employee.id !== ownId) {
    throw new AccessDeniedError(NO_EMPLOYEE_TIME_OFF);
  }
  const identity = await getEmployeeIdentity(current, ownId, { separated: true, session });
  if (!identity) throw new ActionError(EMPLOYEE_GONE);
  return { current, identity };
}

/** The account and the gate, then every rule; throws the first refusal. */
async function checkFiling(
  { identity }: OwnContext,
  values: TimeOffRequestInput,
  {
    attachment,
    exceptRequestId,
    session,
  }: {
    /** `sent`: a new file; `kept`: the returned request's own; `none`. */
    attachment: 'sent' | 'kept' | 'none';
    exceptRequestId: Types.ObjectId | null;
    session: ClientSession | null;
  },
): Promise<{ checked: CheckedTimeOff; settings: LeaveSettings }> {
  if (!identity.active || identity.separated) throw new ActionError(TIME_OFF_ACCOUNT_INACTIVE);
  assertOnboardingGate('fileTimeRequest', await onboardingGateStatus(identity.employeeId, session));
  const today = businessToday();
  const settings = await leaveSettingsOn(today, { session });
  if (attachment === 'sent') {
    if (values.kind === 'offset')
      throw new ActionError(OFFSET_NO_ATTACHMENT, { field: 'attachment' });
    const type = leaveTypeOf(settings, values.leaveTypeKey);
    if (type && !type.attachment) {
      throw new ActionError(LEAVE_TYPE_NO_ATTACHMENT, { field: 'attachment' });
    }
  }
  const checked = await checkTimeOffRequest(
    { identity, settings, today, at: now(), session, exceptRequestId },
    values,
    { hasAttachment: attachment !== 'none' },
  );
  const [problem] = checked.problems;
  if (problem) throw new TimeOffRefusedError(problem);
  return { checked, settings };
}

/** Saves the attachment before the transaction (images re-encoded), owned by the request. */
async function saveAttachment(
  actor: TalentActor,
  requestId: Types.ObjectId,
  file: File,
): Promise<Types.ObjectId> {
  const stored = await saveUpload({
    file,
    owner: { type: TIME_OFF_REQUEST_TYPE, id: requestId },
    actorId: objectIdOf(actor.id),
    field: 'attachment',
    transformImages: 'receipt',
  });
  const fileId = objectIdOf(stored.id);
  if (!fileId) throw new Error('The stored attachment has no valid id.');
  return fileId;
}

function parseRequest(input: unknown): TimeOffRequestInput {
  const parsed = timeOffRequestInputSchema.safeParse(input);
  if (!parsed.success) throw inputError(parsed.error.issues);
  return parsed.data;
}

/** Submits the request's Core approval request, in the caller's transaction. */
async function submitFor(
  requestId: Types.ObjectId,
  number: string,
  { current, identity }: OwnContext,
  values: TimeOffRequestInput,
  checked: CheckedTimeOff,
  hasAttachment: boolean,
  previousRequestId: Types.ObjectId | null,
  session: ClientSession,
): Promise<Types.ObjectId> {
  registerTimeOffApprovalTypes();
  const name = { firstName: identity.firstName, lastName: identity.lastName };
  const span = {
    startDate: values.startDate,
    endDate: values.endDate,
    portion: values.portion,
    fromTime: values.kind === 'offset' ? values.fromTime : null,
    toTime: values.kind === 'offset' ? values.toTime : null,
  };
  const type = checked.type;
  const title =
    values.kind === 'offset' || !type
      ? offsetApprovalTitle({ ...name, ...span, minutes: checked.minutes ?? 0 })
      : leaveApprovalTitle({
          ...name,
          ...span,
          type,
          chargeableHalfDays: checked.chargeableHalfDays ?? 0,
        });
  const summary =
    values.kind === 'offset' || !type
      ? offsetApprovalSummary(checked.minutes ?? 0)
      : leaveApprovalSummary({
          type,
          chargeableHalfDays: checked.chargeableHalfDays ?? 0,
          paidHalfDays: checked.paidHalfDays,
          unpaidHalfDays: checked.unpaidHalfDays,
          hasAttachment,
        });
  const submitted = await submitApproval(
    {
      type: TIME_OFF_APPROVAL_TYPES[values.kind],
      record: { type: TIME_OFF_REQUEST_TYPE, id: requestId, label: number },
      title,
      summary,
      href: timeOffRequestHref(requestId.toHexString()),
      requesterUserId: current.id,
      previousRequestId,
      steps: timeOffApprovalSteps({
        hrRequester: isHrRequester(identity),
        confidential: type?.confidential ?? false,
      }),
    },
    { session },
  );
  return new Types.ObjectId(submitted.id);
}

/** The stored fields of a checked request. */
function requestFields(values: TimeOffRequestInput, checked: CheckedTimeOff) {
  return {
    leaveTypeKey: values.kind === 'leave' ? values.leaveTypeKey : null,
    startDate: instantOf(values.startDate),
    endDate: instantOf(values.endDate),
    portion: values.portion,
    fromTime: values.kind === 'offset' ? values.fromTime : null,
    toTime: values.kind === 'offset' ? values.toTime : null,
    chargeableHalfDays: values.kind === 'leave' ? checked.chargeableHalfDays : null,
    paidHalfDays: values.kind === 'leave' ? checked.paidHalfDays : null,
    unpaidHalfDays: values.kind === 'leave' ? checked.unpaidHalfDays : null,
    minutes: values.kind === 'offset' ? checked.minutes : null,
    reason: values.reason,
  };
}

export interface FiledTimeOff {
  id: string;
  number: string;
  status: 'pending';
}

/**
 * Files leave or offset time off for the signed-in user's own employee (self-service, no employee
 * id). `input` is the request sheet's values (`timeOffRequestInputSchema`); `attachment` the form
 * field `attachment`, or null. Throws {@link TimeOffRefusedError} (an ActionError next to its
 * field) for a refused request, `OnboardingGateError` while `reportingTo` isn't set, and
 * AccessDeniedError for the system account.
 */
export async function fileTimeOff(
  actor: TalentActor,
  input: unknown,
  attachment: File | null = null,
): Promise<FiledTimeOff> {
  const values = parseRequest(input);
  const ownId = assertHasEmployee(actor);
  await connectDb();
  const file = sentFile(attachment);
  const requestId = new Types.ObjectId();
  if (file) {
    // Check first, so an ordinary refusal stores no file.
    await withTransaction(async (session) => {
      await checkFiling(await ownContext(actor, session), values, {
        attachment: 'sent',
        exceptRequestId: null,
        session,
      });
    });
  }
  await ensureTimeOffLock(ownId);
  const fileId = file ? await saveAttachment(actor, requestId, file) : null;

  return withTransaction(async (session) => {
    const own = await ownContext(actor, session);
    await touchTimeOffLock(own.identity.employeeId, session);
    const { checked } = await checkFiling(own, values, {
      attachment: fileId ? 'sent' : 'none',
      exceptRequestId: null,
      session,
    });
    const { number } = await nextDocumentNumber(TIME_OFF_NUMBER_PREFIXES[values.kind], {
      session,
    });
    const approvalRequestId = await submitFor(
      requestId,
      number,
      own,
      values,
      checked,
      fileId !== null,
      null,
      session,
    );
    const actorId = new Types.ObjectId(own.current.id);
    const request = new TimeOffRequestModel({
      _id: requestId,
      number,
      employeeId: new Types.ObjectId(own.identity.employeeId),
      requesterUserId: actorId,
      kind: values.kind,
      ...requestFields(values, checked),
      attachmentFileId: fileId,
      status: 'pending',
      approvalRequestId,
      submittedAt: now(),
      decidedAt: null,
      decidedBy: null,
      remarks: null,
      cancelledAt: null,
      cancelledBy: null,
      cancelReason: null,
      version: 1,
      createdBy: actorId,
      updatedBy: actorId,
    });
    await request.save({ session });
    await recordAudit(
      {
        actorId: own.current.id,
        actorEmail: own.current.email,
        module: 'talent',
        action: 'create',
        record: { type: TIME_OFF_REQUEST_TYPE, id: requestId, label: number },
        before: null,
        after: snapshotForAudit(TimeOffRequestModel, request),
      },
      { session },
    );
    return { id: requestId.toHexString(), number, status: 'pending' as const };
  });
}

/** One of the signed-in user's own requests, in the transaction, or the not-found refusal. */
async function ownRequest(
  { current, identity }: OwnContext,
  requestId: string,
  session: ClientSession,
): Promise<TimeOffRequestDocument> {
  const id = objectIdOf(requestId);
  const request = id
    ? await TimeOffRequestModel.findById(id).session(session).lean<TimeOffRequestDocument>()
    : null;
  // Someone else's request reads as missing, so ids can't be probed from here.
  if (
    !request ||
    request.employeeId.toHexString() !== identity.employeeId ||
    request.requesterUserId.toHexString() !== current.id
  ) {
    throw new ActionError(TIME_OFF_REQUEST_GONE);
  }
  return request;
}

/**
 * "Edit and send again" on a returned request (self-service, the own request only): the sheet's
 * values again, of the same kind, every rule checked again. A new file replaces the attachment;
 * without one the request keeps its own (when its type still takes one). One `update` entry.
 */
export async function resendTimeOff(
  actor: TalentActor,
  requestId: string,
  input: unknown,
  attachment: File | null = null,
): Promise<{ id: string; number: string; status: 'pending' }> {
  const values = parseRequest(input);
  const ownId = assertHasEmployee(actor);
  const id = objectIdOf(requestId);
  if (!id) throw new ActionError(TIME_OFF_REQUEST_GONE);
  await connectDb();
  const file = sentFile(attachment);
  if (file) {
    await withTransaction(async (session) => {
      const own = await ownContext(actor, session);
      const before = await ownRequest(own, requestId, session);
      if (before.status !== 'returned') throw new ActionError(TIME_OFF_NOT_RETURNED);
      if (before.kind !== values.kind)
        throw new ActionError(TIME_OFF_KIND_FIXED, { field: 'kind' });
      await checkFiling(own, values, { attachment: 'sent', exceptRequestId: id, session });
    });
  }
  await ensureTimeOffLock(ownId);
  const fileId = file ? await saveAttachment(actor, id, file) : null;

  return withTransaction(async (session) => {
    const own = await ownContext(actor, session);
    await touchTimeOffLock(own.identity.employeeId, session);
    const before = await ownRequest(own, requestId, session);
    if (before.status !== 'returned') throw new ActionError(TIME_OFF_NOT_RETURNED);
    if (before.kind !== values.kind) throw new ActionError(TIME_OFF_KIND_FIXED, { field: 'kind' });
    const settings = await leaveSettingsOn(businessToday(), { session });
    const type = values.kind === 'leave' ? leaveTypeOf(settings, values.leaveTypeKey) : null;
    // The kept attachment stays only while the type still takes one.
    const keptFileId = type?.attachment ? before.attachmentFileId : null;
    const attachmentFileId = fileId ?? keptFileId;
    const { checked } = await checkFiling(own, values, {
      attachment: fileId ? 'sent' : keptFileId ? 'kept' : 'none',
      exceptRequestId: before._id,
      session,
    });
    const approvalRequestId = await submitFor(
      before._id,
      before.number,
      own,
      values,
      checked,
      attachmentFileId !== null,
      before.approvalRequestId,
      session,
    );
    const actorId = new Types.ObjectId(own.current.id);
    const after = await TimeOffRequestModel.findOneAndUpdate(
      { _id: before._id, version: before.version, status: 'returned' },
      {
        $set: {
          ...requestFields(values, checked),
          attachmentFileId,
          status: 'pending',
          approvalRequestId,
          submittedAt: now(),
          decidedAt: null,
          decidedBy: null,
          remarks: null,
          updatedBy: actorId,
        },
        $inc: { version: 1 },
      },
      { session, returnDocument: 'after', runValidators: true },
    ).lean<TimeOffRequestDocument>();
    if (!after) throw new ActionError(TIME_OFF_REQUEST_GONE);
    await recordAudit(
      {
        actorId: own.current.id,
        actorEmail: own.current.email,
        module: 'talent',
        action: 'update',
        record: { type: TIME_OFF_REQUEST_TYPE, id: before._id, label: timeOffAuditLabel(before) },
        ...snapshotsForAudit(TimeOffRequestModel, before, after),
        reason: 'Sent again',
      },
      { session },
    );
    return { id: before._id.toHexString(), number: before.number, status: 'pending' as const };
  });
}

/** The user ids asked on the approval request `approvalRequestId` of the request. */
async function approverUserIdsOf(
  viewer: { id: string },
  request: TimeOffRequestDocument,
): Promise<string[]> {
  const requestId = request.approvalRequestId?.toHexString();
  if (!requestId) return [];
  const approvals = await listApprovalsForRecord(
    viewer,
    TIME_OFF_REQUEST_TYPE,
    request._id.toHexString(),
  );
  const approval = approvals.find((candidate) => candidate.id === requestId);
  const ids = new Set<string>();
  for (const step of approval?.steps ?? []) {
    for (const approver of step.approvers) ids.add(approver.userId);
  }
  return [...ids];
}

/**
 * "Cancel request" (self-service, the own request only): a returned request, or an approved one
 * before its first day (HANDOFF item 166). An approved one gives its paid half days or minutes
 * back with a `usage` entry and tells its approvers (`talent.timeOffCancelled`). Final.
 */
export async function cancelTimeOff(
  actor: TalentActor,
  input: CancelTimeOffInput,
): Promise<{ id: string; status: 'cancelled' }> {
  const parsed = cancelTimeOffInputSchema.safeParse(input);
  if (!parsed.success) throw inputError(parsed.error.issues);
  assertHasEmployee(actor);
  await connectDb();
  return withTransaction(async (session) => {
    const own = await ownContext(actor, session);
    const before = await ownRequest(own, parsed.data.requestId, session);
    const today = businessToday();
    if (!canCancelTimeOff({ status: before.status, startDate: dayOf(before.startDate) }, today)) {
      throw new ActionError(
        before.status === 'approved' ? TIME_OFF_CANCEL_STARTED_MESSAGE : TIME_OFF_NOT_CANCELLABLE,
      );
    }
    const actorId = new Types.ObjectId(own.current.id);
    const after = await TimeOffRequestModel.findOneAndUpdate(
      { _id: before._id, version: before.version, status: before.status },
      {
        $set: {
          status: 'cancelled',
          cancelledAt: now(),
          cancelledBy: actorId,
          cancelReason: parsed.data.reason,
          updatedBy: actorId,
        },
        $inc: { version: 1 },
      },
      { session, returnDocument: 'after', runValidators: true },
    ).lean<TimeOffRequestDocument>();
    if (!after) throw new ActionError(TIME_OFF_REQUEST_GONE);
    await recordAudit(
      {
        actorId: own.current.id,
        actorEmail: own.current.email,
        module: 'talent',
        action: 'update',
        record: { type: TIME_OFF_REQUEST_TYPE, id: before._id, label: timeOffAuditLabel(before) },
        ...snapshotsForAudit(TimeOffRequestModel, before, after),
        reason: parsed.data.reason,
      },
      { session },
    );

    if (before.status === 'approved') {
      const author = { userId: own.current.id, email: own.current.email };
      const employeeId = own.identity.employeeId;
      const settings = await leaveSettingsOn(today, { session });
      const type = typeOfRequest(settings, before);
      if (before.kind === 'offset' && before.minutes) {
        await writeOffsetUsage(
          { employeeId, minutes: before.minutes, effectiveOn: today, requestId: before._id },
          author,
          session,
        );
      }
      if (before.kind === 'leave' && type?.balance === 'credited' && before.paidHalfDays) {
        await writeLeaveUsage(
          {
            employeeId,
            typeKey: type.key,
            halfDays: before.paidHalfDays,
            effectiveOn: today,
            requestId: before._id,
          },
          author,
          session,
        );
      }
      const recipients = await approverUserIdsOf(own.current, before);
      if (recipients.length > 0) {
        await notify(
          {
            recipients,
            module: 'talent',
            event: TIME_OFF_CANCELLED_EVENT,
            title: timeOffCancelledMessage({
              firstName: own.identity.firstName,
              lastName: own.identity.lastName,
              kind: before.kind,
              typeLabel: type ? leaveTypeShortLabel(type, false) : null,
              ...spanOf(before),
            }),
            href: timeOffRequestHref(before._id.toHexString()),
            record: { type: TIME_OFF_REQUEST_TYPE, id: before._id },
          },
          { session },
        );
      }
    }
    return { id: before._id.toHexString(), status: 'cancelled' as const };
  });
}

// ---------------------------------------------------------------------------------------------
// The request sheet's preview

/**
 * The request sheet's summary before Submit (self-service): the days with their charge, the
 * chargeable days or hours, the paid and unpaid split, and every refusal found so far in the
 * service's words (the gate's and the account's first). `hasAttachment` is whether the sheet holds
 * a file. Writes nothing.
 */
export async function previewTimeOff(
  actor: TalentActor,
  input: unknown,
  { hasAttachment = false }: { hasAttachment?: boolean } = {},
): Promise<TimeOffPreviewView> {
  const ownId = assertHasEmployee(actor);
  const empty: TimeOffPreviewView = {
    days: [],
    chargeableHalfDays: null,
    paidHalfDays: null,
    unpaidHalfDays: null,
    minutes: null,
    problems: [],
  };
  const parsed = timeOffRequestInputSchema.safeParse(input);
  if (!parsed.success) {
    return { ...empty, problems: parsed.error.issues.map((issue) => issue.message) };
  }
  await connectDb();
  const identity = await getEmployeeIdentity(actor, ownId, { separated: true });
  if (!identity) throw new ActionError(EMPLOYEE_GONE);
  const problems: string[] = [];
  if (!identity.active || identity.separated) problems.push(TIME_OFF_ACCOUNT_INACTIVE);
  const gate = await onboardingGateStatus(identity.employeeId, null);
  const missing = checkOnboardingGate('fileTimeRequest', gate);
  if (missing.length > 0) problems.push(onboardingGateMessage(missing, gate));
  const today = businessToday();
  const settings = await leaveSettingsOn(today);
  if (parsed.data.kind === 'leave' && !leaveTypeOf(settings, parsed.data.leaveTypeKey)) {
    return { ...empty, problems: [...problems, LEAVE_TYPE_UNKNOWN] };
  }
  const checked = await checkTimeOffRequest(
    { identity, settings, today, at: now(), session: null, exceptRequestId: null },
    parsed.data,
    { hasAttachment },
  );
  return {
    days: checked.days,
    chargeableHalfDays: checked.chargeableHalfDays,
    paidHalfDays: checked.paidHalfDays,
    unpaidHalfDays: checked.unpaidHalfDays,
    minutes: checked.minutes,
    problems: [...problems, ...checked.problems.map(timeOffProblemMessage)],
  };
}

// ---------------------------------------------------------------------------------------------
// Reads

/** A leave type as the request sheet offers it (active types only). */
export interface TimeOffSheetLeaveType {
  key: string;
  name: string;
  shortName: string;
  balance: LeaveBalanceKind;
  countDays: LeaveCountDays;
  halfDays: boolean;
  paid: boolean;
  attachment: LeaveAttachment | null;
  /** "File VL by Oct 15 for Oct 29" style, with no day chosen: "File VL at least 14 days ahead". */
  filingWindowText: string | null;
  allowFuture: boolean;
  allowPast: boolean;
  minNoticeDays: number | null;
}

/** The employee as the time off pages name them (directory fields only). */
export interface TimeOffEmployeeView {
  id: string;
  name: string;
  employeeNumber: string;
}

/** `/talent/time-off/<employeeId>`, read-only. */
export interface EmployeeTimeOffView {
  today: BusinessDate;
  employee: TimeOffEmployeeView;
  /** True on the signed-in user's own page. */
  own: boolean;
  balances: LeaveBalancesView | null;
  offset: OffsetAvailableBalanceView | null;
  /** Newest first. */
  requests: TimeOffRequestView[];
}

/** `/talent/time-off`, the signed-in user's own: the read-only parts plus the request sheet. */
export interface OwnTimeOffView extends EmployeeTimeOffView {
  sheet: {
    leaveTypes: TimeOffSheetLeaveType[];
    offset: { minimumMinutes: number; stepMinutes: number };
    /** The gate's notice while `reportingTo` isn't set, or null. */
    gateMessage: string | null;
  };
}

/** `/talent/time-off-requests/<id>`. */
export interface TimeOffRequestPageView {
  today: BusinessDate;
  employee: TimeOffEmployeeView;
  own: boolean;
  request: TimeOffRequestView;
  /** The type's name ("Vacation leave"), "Leave" when hidden, or "Offset time off". */
  typeName: string;
  /** The request's days as they count now, with their paid and unpaid parts. */
  days: TimeOffRequestDay[];
  /** "Open attachment": the file route URL, or null. */
  attachmentHref: string | null;
  /** The approval history, newest first. */
  approvals: ApprovalDetail[];
  /** "Waiting for your approval · Open in Approvals", for a pending approver. */
  approverLink: { requestId: string; href: string } | null;
}

function employeeViewOf(identity: EmployeeIdentity): TimeOffEmployeeView {
  const directory = toDirectoryIdentity(identity);
  return {
    id: directory.employeeId,
    name: `${directory.firstName} ${directory.lastName}`,
    employeeNumber: directory.employeeNumber,
  };
}

interface RequestViewContext {
  actor: TalentActor;
  settings: LeaveSettings;
  today: BusinessDate;
  own: boolean;
  canSeeConfidential: boolean;
}

async function requestViewOf(
  request: TimeOffRequestDocument,
  { actor, settings, today, own, canSeeConfidential }: RequestViewContext,
): Promise<TimeOffRequestView> {
  const type = typeOfRequest(settings, request);
  const hidden = type !== null && type.confidential && !canSeeConfidential;
  const id = request._id.toHexString();
  const employeeId = request.employeeId.toHexString();
  let canOpenAttachment = false;
  if (request.attachmentFileId && !hidden) {
    canOpenAttachment =
      canOpenTimeOffAttachment(actor, employeeId) ||
      canOpenTimeOffAttachment(actor, employeeId, {
        approver: await isApproverFor(actor.id, TIME_OFF_REQUEST_TYPE, id),
      });
  }
  return {
    id,
    number: request.number,
    employeeId,
    kind: request.kind,
    leaveTypeKey: hidden ? null : request.leaveTypeKey,
    typeLabel:
      request.kind === 'offset'
        ? null
        : type
          ? leaveTypeShortLabel(type, canSeeConfidential)
          : CONFIDENTIAL_LEAVE_LABEL,
    balanceKind: hidden ? null : (type?.balance ?? null),
    startDate: dayOf(request.startDate),
    endDate: dayOf(request.endDate),
    portion: request.portion,
    fromTime: request.fromTime,
    toTime: request.toTime,
    chargeableHalfDays: request.chargeableHalfDays,
    paidHalfDays: hidden ? null : request.paidHalfDays,
    unpaidHalfDays: hidden ? null : request.unpaidHalfDays,
    minutes: request.minutes,
    reason: hidden ? null : request.reason,
    canOpenAttachment,
    status: request.status,
    approvalRequestId: request.approvalRequestId?.toHexString() ?? null,
    submittedAt: request.submittedAt,
    decidedAt: request.decidedAt,
    // The approver's remarks and the cancel reason can name a confidential type too.
    remarks: hidden ? null : request.remarks,
    cancelledAt: request.cancelledAt,
    cancelReason: hidden ? null : request.cancelReason,
    canCancel:
      own &&
      canCancelTimeOff({ status: request.status, startDate: dayOf(request.startDate) }, today),
    canEditAndResend: own && request.status === 'returned',
  };
}

async function requestsOf(employeeId: string): Promise<TimeOffRequestDocument[]> {
  return TimeOffRequestModel.find({ employeeId: new Types.ObjectId(employeeId) })
    .sort({ submittedAt: -1, _id: -1 })
    .limit(200)
    .lean<TimeOffRequestDocument[]>();
}

async function employeeTimeOffOf(
  actor: TalentActor,
  identity: EmployeeIdentity,
): Promise<EmployeeTimeOffView> {
  const today = businessToday();
  const own = actor.employee?.id === identity.employeeId;
  const [settings, balances, offset, stored] = await Promise.all([
    leaveSettingsOn(today),
    getLeaveBalances(actor, identity.employeeId),
    getOffsetBalance(actor, identity.employeeId),
    requestsOf(identity.employeeId),
  ]);
  const context: RequestViewContext = {
    actor,
    settings,
    today,
    own,
    canSeeConfidential: canSeeConfidentialFor(actor, identity.employeeId),
  };
  return {
    today,
    employee: employeeViewOf(identity),
    own,
    balances,
    offset,
    requests: await Promise.all(stored.map((request) => requestViewOf(request, context))),
  };
}

/**
 * `/talent/time-off`: the signed-in user's own balances and requests, and what the request sheet
 * offers (self-service: no employee id). The system account is refused.
 */
export async function getOwnTimeOff(actor: TalentActor): Promise<OwnTimeOffView> {
  const ownId = assertHasEmployee(actor);
  await connectDb();
  const identity = await getEmployeeIdentity(actor, ownId, { separated: true });
  if (!identity) throw new ActionError(EMPLOYEE_GONE);
  const today = businessToday();
  const [view, settings, gate] = await Promise.all([
    employeeTimeOffOf(actor, identity),
    leaveSettingsOn(today),
    onboardingGateStatus(identity.employeeId, null),
  ]);
  const missing = checkOnboardingGate('fileTimeRequest', gate);
  return {
    ...view,
    sheet: {
      leaveTypes: settings.types
        .filter((type) => type.active)
        .map((type) => ({
          key: type.key,
          name: type.name,
          shortName: type.shortName,
          balance: type.balance,
          countDays: type.countDays,
          halfDays: type.halfDays,
          paid: type.paid,
          attachment: type.attachment,
          filingWindowText: leaveFilingWindowText(type, null),
          allowFuture: type.filing.allowFuture,
          allowPast: type.filing.allowPast,
          minNoticeDays: type.filing.minNoticeDays,
        })),
      offset: { ...settings.offsetTimeOff },
      gateMessage: missing.length > 0 ? onboardingGateMessage(missing, gate) : null,
    },
  };
}

/**
 * `/talent/time-off/<employeeId>`, read-only: for the employee, Talent Read, a `reportingTo`
 * supervisor, or anyone who is or was an approver on one of the employee's requests, whatever
 * their module access (AccessDeniedError for anyone else). Directory fields only about the
 * employee. Null when there is no such employee.
 */
export async function getEmployeeTimeOff(
  actor: TalentActor,
  employeeId: string,
): Promise<EmployeeTimeOffView | null> {
  await connectDb();
  const viewer = await timeOffViewerIdentity(actor, employeeId);
  if (!viewer) return null;
  return employeeTimeOffOf(actor, viewer.identity);
}

/**
 * `/talent/time-off-requests/<id>`: one request with its days, split, attachment link, reason,
 * status and approval history. For the employee, Talent Read, a `reportingTo` supervisor, the
 * System Administrator, and anyone who is or was an approver on this request (AccessDeniedError
 * for anyone else). Null when there is no such request.
 */
export async function getTimeOffRequestPage(
  actor: TalentActor,
  requestId: string,
): Promise<TimeOffRequestPageView | null> {
  const id = objectIdOf(requestId);
  if (!id) return null;
  await connectDb();
  const request = await TimeOffRequestModel.findById(id).lean<TimeOffRequestDocument>();
  if (!request) return null;
  const employeeId = request.employeeId.toHexString();
  const approver = await isApproverFor(actor.id, TIME_OFF_REQUEST_TYPE, requestId);
  let identity: EmployeeIdentity;
  try {
    const viewer = await timeOffViewerIdentity(actor, employeeId);
    if (!viewer) return null;
    // The approver rule there covers any of the employee's requests; this page needs this one.
    if (viewer.approver && !approver && !isSystemAdministrator(actor)) {
      throw new AccessDeniedError(TIME_OFF_REQUEST_DENIED);
    }
    identity = viewer.identity;
  } catch (error) {
    if (!(error instanceof AccessDeniedError) || !isSystemAdministrator(actor)) throw error;
    const subject = await serviceIdentity(employeeId);
    if (!subject) return null;
    identity = subject;
  }

  const today = businessToday();
  const settings = await leaveSettingsOn(today);
  const own = actor.employee?.id === employeeId;
  const canSeeConfidential = canSeeConfidentialFor(actor, employeeId);
  const view = await requestViewOf(request, { actor, settings, today, own, canSeeConfidential });
  const type = typeOfRequest(settings, request);
  const span = spanOf(request);
  const context = await loadTimeOffContext(employeeId, identity, {
    from: span.startDate,
    to: span.endDate,
  });
  const days = storedRequestDays(request, type, context);
  const listed = await listApprovalsForRecord(actor, TIME_OFF_REQUEST_TYPE, requestId);
  const hidden = type !== null && type.confidential && !canSeeConfidential;
  // A confidential type's history shows who decided and when, never the remarks (a reason).
  const approvals = hidden
    ? listed.map((approval) => ({
        ...approval,
        steps: approval.steps.map((step) => ({
          ...step,
          approvers: step.approvers.map((approver) =>
            approver.decision
              ? { ...approver, decision: { ...approver.decision, remarks: null } }
              : approver,
          ),
        })),
      }))
    : listed;
  const current = approvals.find((approval) => approval.id === view.approvalRequestId) ?? null;
  return {
    today,
    employee: employeeViewOf(identity),
    own,
    request: view,
    typeName:
      request.kind === 'offset'
        ? 'Offset time off'
        : type
          ? leaveTypeNameLabel(type, canSeeConfidential)
          : CONFIDENTIAL_LEAVE_LABEL,
    days,
    attachmentHref:
      view.canOpenAttachment && request.attachmentFileId
        ? fileUrlOf(request.attachmentFileId)
        : null,
    approvals,
    approverLink:
      current && current.status === 'pending' && current.allowedDecisions.length > 0
        ? { requestId: current.id, href: approvalHref(current.id) }
        : null,
  };
}
