import { type ClientSession, Types } from 'mongoose';
import { connectDb, withTransaction } from '@pulse/db';
import {
  AccessDeniedError,
  ActionError,
  approvalHref,
  businessToday,
  formatDate,
  now,
} from '@pulse/core';
import {
  activeHrUserIds,
  type ApprovalHookContext,
  type ApprovalStepSpec,
  canRevealSensitive,
  type EmployeeIdentity,
  employeeAuditLabel,
  employeeNotificationContacts,
  getEmployeeIdentity,
  getSensitiveSubject,
  isApproverFor,
  recordAudit,
  registerApprovalType,
  type ReloadedActor,
  reloadActorAccess,
  ROLE_DEPARTMENT_CODES,
  sensitiveLastFour,
  snapshotForAudit,
  snapshotsForAudit,
  submitApproval,
  userNames,
} from '@pulse/core/server';
import {
  CHANGE_REQUEST_SECTION_LABELS,
  CHANGE_REQUEST_STATUS_LABELS,
  type ChangeRequestSection,
  type ChangeRequestStatus,
  CIVIL_STATUS_LABELS,
  type CivilStatus,
  PAYROLL_BANK_LABELS,
  type PayrollBank,
  SEX_LABELS,
  type Sex,
} from '../../fixed-sets';
import {
  CHANGE_REQUEST_ALREADY_OPEN,
  CHANGE_REQUEST_FIELD_LABELS,
  CHANGE_REQUEST_NOTHING_CHANGED,
  changeRequestApprovers,
  changeRequestAuditLabel,
  changeRequestHref,
  changeRequestNoLongerApprovable,
  changeRequestSummary,
  changeRequestTitle,
  type ChangeRequestField,
  isSensitiveChangeRequestField,
} from '../../onboarding/change-requests';
import {
  type CancelChangeRequestInput,
  cancelChangeRequestSchema,
  OWN_SECTION_SCHEMAS,
  type ResendChangeRequestInput,
  resendChangeRequestSchema,
} from '../../onboarding/inputs';
import type {
  ChangeRequestFieldView,
  ChangeRequestView,
  OwnChangeRequestListItem,
  OwnSectionEditView,
} from '../../onboarding/views';
import { RECORD_CHANGED_ELSEWHERE } from '../../validation';
import {
  BANK_ACCOUNT_NUMBER_FIELD,
  EMPLOYEE_RECORD_TYPE,
  type MaskedDigitsView,
} from '../../views';
import {
  EMPLOYEE_RECORD_SENSITIVE_SELECT,
  type EmployeeRecordDocument,
  EmployeeRecordModel,
} from '../employee-records/model';
import { loadRecordForWrite, writeEmployeeRecord } from '../employee-records/write';
import { inputError } from '../input';
import {
  CHANGE_REQUEST_DENIED,
  canSeeChangeRequestSection,
  changeRequestApprovalRefusal,
  NO_EMPLOYEE_RECORD,
  type RecordTarget,
  type TalentActor,
} from '../policy';
import { isDuplicateKey, objectIdOf } from '../shared';
import { registerTimeOffApprovalTypes } from '../time-off/approval';
import { registerTimesheetApprovalType } from '../timesheets/approval';
import {
  CHANGE_REQUEST_SENSITIVE_SELECT,
  type ChangeRequestDocument,
  ChangeRequestModel,
  type ChangeRequestValues,
} from './model';
import {
  checkSectionValues,
  compareSection,
  formValuesOf,
  ownSectionOf,
  proposedOf,
  RECORD_PATHS,
  type SectionFormValues,
  valueAt,
} from './values';

// Spec: docs/modules/talent.md#onboarding-checklist-and-change-requests-build-step-26 ("Change
// requests", "Applying on approval", "Who sees a change request"; decisions 269–274 in
// docs/BUILD_PLAN.md), docs/modules/core.md#approvals and SECURITY.md#sensitive-data.
//
// - Sending: the employee's own save (employee-records/own.ts) or "Edit and send again" on a
//   returned request. In one transaction: the request, its Core approval request (type
//   `talent.changeRequest`, one `anyOf` step worked out here, `whenEmpty: 'systemAdministrator'`),
//   and a `create` (or `update`) entry on `talent.changeRequest`. The title and summary name the
//   section and the field labels only, never a value.
// - Deciding: the type's `onSettled` hook runs in the decision's transaction. On approve it checks
//   the approver's role against the employee as they are now, writes the changed fields over the
//   record (raising its `version`), keeps the previous values on the request, verifies an IDs or
//   bank change to the approver, and writes both audit entries. Return and reject set the status.
// - Cancelling: a returned request only. A pending one can't be withdrawn (the engine has no
//   withdraw, HANDOFF item 100): the employee asks the approver to return it, then cancels it.
// - Seeing: the requester, its approvers (`isApproverFor`), the System Administrator, and Talent
//   Read users who may see that section of the employee's record. Sensitive values are masked
//   (last 4) with Reveal (`talent.changeRequest`, registered in sensitive/reveals.ts).

/** The approval type, the approval's record type and the audit record type. */
export const CHANGE_REQUEST_TYPE = 'talent.changeRequest';
/** The approval type's label in the Approvals list. */
export const CHANGE_REQUEST_TYPE_LABEL = 'Change request';
/** The audit reason on the employee record when an approved change is applied. */
export const CHANGE_REQUEST_APPROVED_REASON = 'Change request approved';

export const CHANGE_REQUEST_GONE = 'This change request can’t be found. Reload to see it.';
export const CHANGE_REQUEST_NOT_RETURNED =
  'Only a returned change request can be edited and sent again, or cancelled. Reload to see where it stands.';

const STEP_LABELS = {
  supervisorsAndHr: 'Supervisor or HR',
  hr: 'HR',
  board: 'Board of Directors',
} as const;

function isInHr(target: RecordTarget): boolean {
  return target.departmentCode === ROLE_DEPARTMENT_CODES.hr;
}

function targetOfIdentity(identity: EmployeeIdentity): RecordTarget {
  return { employeeId: identity.employeeId, departmentCode: identity.department?.code ?? null };
}

/**
 * The one approval step of a change to `section` of `target`'s record (decision 269): the active
 * `reportingTo` supervisors and every active HR user for Contact details and Skills; HR for
 * Personal details and a non-HR employee's IDs and bank; the Board for an HR employee's IDs and
 * bank. The engine drops the requester, and an empty step goes to the System Administrators.
 */
export async function changeRequestStepFor(
  section: ChangeRequestSection,
  target: RecordTarget,
  session: ClientSession | null = null,
): Promise<ApprovalStepSpec> {
  const approvers = changeRequestApprovers(section, isInHr(target));
  if (approvers === 'supervisorsAndHr') {
    const [contact] = await employeeNotificationContacts([target.employeeId], { session });
    const hr = await activeHrUserIds({ session });
    const userIds = [...new Set([...(contact?.supervisorUserIds ?? []), ...hr])];
    return { kind: 'anyOf', label: STEP_LABELS.supervisorsAndHr, approvers: { userIds } };
  }
  return {
    kind: 'anyOf',
    label: STEP_LABELS[approvers],
    approvers: { set: approvers === 'board' ? 'board' : 'hr' },
  };
}

// ---------------------------------------------------------------------------------------------
// The approval type

let registered = false;

/**
 * Registers `talent.changeRequest`, from step 2.7 `talent.timesheet`, and from step 2.8
 * `talent.leave` and `talent.offsetTimeOff` with Core's approvals engine. The approvals Server Action calls it beside `registerCoreApprovalTypes()` and
 * `registerTalentApprovalSigner()`; the change request and timesheet services call it themselves
 * before submitting. Safe to call on every request.
 */
export function registerTalentApprovalTypes(): void {
  registerTimesheetApprovalType();
  registerTimeOffApprovalTypes();
  if (registered) return;
  registerApprovalType(CHANGE_REQUEST_TYPE, {
    module: 'talent',
    label: CHANGE_REQUEST_TYPE_LABEL,
    allowedDecisions: ['approve', 'return', 'reject'],
    whenEmpty: 'systemAdministrator',
    onSettled: onChangeRequestSettled,
  });
  registered = true;
}

/** The audit label of a request: `<employee number> · <section label>`. */
async function auditLabelOf(
  employeeId: Types.ObjectId,
  section: ChangeRequestSection,
  session: ClientSession,
): Promise<string> {
  const employee = await employeeAuditLabel(employeeId, { session });
  return changeRequestAuditLabel(employee?.employeeNumber ?? 'Unknown employee', section);
}

/** The hook (decision 273). Runs in the decision's transaction; throwing rolls it back. */
async function onChangeRequestSettled({
  request,
  decision,
  session,
}: ApprovalHookContext): Promise<void> {
  const id = objectIdOf(request.record.id);
  const before = id
    ? ((await ChangeRequestModel.findById(id)
        .select(CHANGE_REQUEST_SENSITIVE_SELECT)
        .session(session)
        .lean()) as ChangeRequestDocument | null)
    : null;
  if (
    !before ||
    before.status !== 'pending' ||
    before.approvalRequestId?.toHexString() !== request.id
  ) {
    throw new Error('The change request for this approval is missing or no longer pending.');
  }
  const decidedAt = now();
  const deciderId = new Types.ObjectId(decision.userId);
  const set: Record<string, unknown> = {
    decidedBy: deciderId,
    decidedAt,
    remarks: decision.remarks,
    updatedBy: deciderId,
  };

  if (decision.decision === 'approve') {
    const approver = await reloadActorAccess({ id: decision.userId }, session);
    const subject = await getSensitiveSubject(before.employeeId, { session });
    if (!subject) throw new ActionError('This employee no longer exists.');
    const refusal = changeRequestApprovalRefusal(approver, before.section, subject);
    if (refusal) throw new ActionError(changeRequestNoLongerApprovable(refusal));

    const employee = await employeeAuditLabel(before.employeeId, { session });
    const existing = await loadRecordForWrite(before.employeeId, session);
    const fields = before.changedFields as ChangeRequestField[];
    const { changes, previous } = applicationOfRequest(fields, before.proposed, existing);
    if (before.section === 'governmentIds' || before.section === 'bankAccount') {
      // The approver may verify by the routing (decision 266).
      changes[`${before.section}Verification`] = { verifiedAt: decidedAt, verifiedBy: deciderId };
    }
    await writeEmployeeRecord({
      actor: approver,
      employeeId: before.employeeId.toHexString(),
      label: employee
        ? `${employee.employeeNumber} · ${employee.name}`
        : before.employeeId.toHexString(),
      existing,
      changes,
      reason: CHANGE_REQUEST_APPROVED_REASON,
      session,
    });
    set.status = 'approved';
    set.previous = previous;
  } else {
    set.status = decision.decision === 'return' ? 'returned' : 'rejected';
  }

  const after = (await ChangeRequestModel.findOneAndUpdate(
    { _id: before._id, version: before.version, status: 'pending' },
    { $set: set, $inc: { version: 1 } },
    { session, returnDocument: 'after', runValidators: true },
  )
    .select(CHANGE_REQUEST_SENSITIVE_SELECT)
    .lean()) as ChangeRequestDocument | null;
  if (!after) throw new ActionError(RECORD_CHANGED_ELSEWHERE);
  await recordAudit(
    {
      actorId: decision.userId,
      actorEmail: decision.email,
      module: 'talent',
      action: 'update',
      record: {
        type: CHANGE_REQUEST_TYPE,
        id: before._id,
        label: await auditLabelOf(before.employeeId, before.section, session),
      },
      ...snapshotsForAudit(ChangeRequestModel, before, after),
      reason: decision.remarks,
    },
    { session },
  );
}

/** The record's `$set` for an approved request, and the values it replaces (values.ts). */
function applicationOfRequest(
  fields: readonly ChangeRequestField[],
  proposed: ChangeRequestValues,
  record: EmployeeRecordDocument | null,
): { changes: Record<string, unknown>; previous: ChangeRequestValues } {
  const changes: Record<string, unknown> = {};
  const previous: Record<string, unknown> = {};
  for (const field of fields) {
    const value = (proposed as Record<string, unknown>)[field];
    const sensitive = isSensitiveChangeRequestField(field);
    // A sensitive value is never cleared on the record: none means no change.
    if (sensitive && (value === undefined || value === null)) continue;
    changes[RECORD_PATHS[field]] = value === undefined ? null : value;
    const before = valueAt(record, RECORD_PATHS[field]);
    // A sensitive value is copied as its ciphertext; an absent one stays absent.
    if (!sensitive || before !== null) previous[field] = before;
  }
  return { changes, previous: previous as ChangeRequestValues };
}

// ---------------------------------------------------------------------------------------------
// Sending

export interface SendChangeRequestInput {
  /** The requester, reloaded in this transaction (the employee themselves). */
  current: ReloadedActor;
  identity: EmployeeIdentity;
  section: ChangeRequestSection;
  /** The fields that change (fill or change), in the section's order: at least one. */
  fields: ChangeRequestField[];
  /** The form's plain values of the section. */
  values: SectionFormValues;
  note: string | null;
  session: ClientSession;
}

/** True when the employee has an open (pending or returned) request for `section`. */
export async function hasOpenChangeRequest(
  employeeId: string,
  section: ChangeRequestSection,
  session: ClientSession | null = null,
): Promise<boolean> {
  const found = await ChangeRequestModel.exists({
    employeeId: new Types.ObjectId(employeeId),
    section,
    status: { $in: ['pending', 'returned'] },
  }).session(session);
  return found !== null;
}

/** Submits the Core approval request for a change request, in the caller's transaction. */
async function submitFor(
  changeRequestId: Types.ObjectId,
  { current, identity, section, fields, session }: SendChangeRequestInput,
  previousRequestId: Types.ObjectId | null,
): Promise<Types.ObjectId> {
  registerTalentApprovalTypes();
  const submitted = await submitApproval(
    {
      type: CHANGE_REQUEST_TYPE,
      record: {
        type: CHANGE_REQUEST_TYPE,
        id: changeRequestId,
        label: changeRequestAuditLabel(identity.employeeNumber, section),
      },
      title: changeRequestTitle(section, identity.firstName, identity.lastName),
      summary: changeRequestSummary(section, fields),
      href: changeRequestHref(changeRequestId.toHexString()),
      requesterUserId: current.id,
      previousRequestId,
      steps: [await changeRequestStepFor(section, targetOfIdentity(identity), session)],
    },
    { session },
  );
  return new Types.ObjectId(submitted.id);
}

/**
 * Sends a new change request for one section of the employee's own record, in the caller's
 * transaction (the own save's): the request, its approval request and its `create` entry. The
 * caller has checked that the section has no open request; the partial unique index refuses a
 * second one anyway. Returns the request's id.
 */
export async function sendChangeRequestInSession(input: SendChangeRequestInput): Promise<string> {
  const { current, identity, section, fields, values, note, session } = input;
  if (fields.length === 0) throw new ActionError(CHANGE_REQUEST_NOTHING_CHANGED);
  const id = new Types.ObjectId();
  const approvalRequestId = await submitFor(id, input, null);
  const actorId = new Types.ObjectId(current.id);
  const request = new ChangeRequestModel({
    _id: id,
    employeeId: new Types.ObjectId(identity.employeeId),
    requesterUserId: actorId,
    section,
    changedFields: fields,
    proposed: await proposedOf(fields, values),
    previous: null,
    note,
    status: 'pending',
    sentAt: now(),
    approvalRequestId,
    decidedBy: null,
    decidedAt: null,
    remarks: null,
    version: 1,
    createdBy: actorId,
    updatedBy: actorId,
  });
  await request.save({ session });
  await recordAudit(
    {
      actorId: current.id,
      actorEmail: current.email,
      module: 'talent',
      action: 'create',
      record: {
        type: CHANGE_REQUEST_TYPE,
        id,
        label: changeRequestAuditLabel(identity.employeeNumber, section),
      },
      before: null,
      after: snapshotForAudit(ChangeRequestModel, request),
    },
    { session },
  );
  return id.toHexString();
}

/** True for the duplicate key error of the one-open-request-per-section index. */
export function isOpenRequestConflict(error: unknown): boolean {
  if (!isDuplicateKey(error)) return false;
  const pattern = (error as { keyPattern?: Record<string, unknown> }).keyPattern;
  return pattern !== undefined && 'section' in pattern;
}

/** The actor's own employee, reloaded in the transaction, or AccessDeniedError. */
async function ownEmployee(
  actor: TalentActor,
  session: ClientSession,
): Promise<{ current: ReloadedActor; identity: EmployeeIdentity }> {
  const ownId = actor.employee?.id;
  if (!ownId) throw new AccessDeniedError(NO_EMPLOYEE_RECORD);
  const current = await reloadActorAccess({ id: actor.id }, session);
  if (!current.employee || current.employee.id !== ownId) {
    throw new AccessDeniedError(NO_EMPLOYEE_RECORD);
  }
  const identity = await getEmployeeIdentity(current, ownId, { session });
  if (!identity) throw new ActionError('Your employee record no longer exists.');
  return { current, identity };
}

/** One of the actor's own requests, in the transaction, or the not-found message. */
async function ownRequest(
  current: ReloadedActor,
  changeRequestId: string,
  session: ClientSession,
): Promise<ChangeRequestDocument> {
  const id = objectIdOf(changeRequestId);
  const request = id
    ? ((await ChangeRequestModel.findById(id)
        .select(CHANGE_REQUEST_SENSITIVE_SELECT)
        .session(session)
        .lean()) as ChangeRequestDocument | null)
    : null;
  // Someone else's request reads as missing, so ids can't be probed from here.
  if (
    !request ||
    request.requesterUserId.toHexString() !== current.id ||
    request.employeeId.toHexString() !== current.employee?.id
  ) {
    throw new ActionError(CHANGE_REQUEST_GONE);
  }
  return request;
}

/**
 * "Edit and send again" on a returned request (self-service, the employee's own only): `values`
 * are the on-screen section's form values, parsed with its own sheet's schema; only this
 * request's section is taken from them, compared with the record as it is now. The request goes
 * back to `pending` with a new approval request linked to the old one (`previousRequestId`),
 * routed for the employee as they are now. One `update` entry on `talent.changeRequest`.
 */
export async function resendChangeRequest(
  actor: TalentActor,
  input: ResendChangeRequestInput,
): Promise<{ id: string; status: ChangeRequestStatus }> {
  const parsed = resendChangeRequestSchema.safeParse(input);
  if (!parsed.success) throw inputError(parsed.error.issues);
  const { changeRequestId, note, values: rawValues } = parsed.data;
  if (!actor.employee) throw new AccessDeniedError(NO_EMPLOYEE_RECORD);
  await connectDb();

  try {
    return await withTransaction(async (session) => {
      const { current, identity } = await ownEmployee(actor, session);
      const before = await ownRequest(current, changeRequestId, session);
      if (before.status !== 'returned') throw new ActionError(CHANGE_REQUEST_NOT_RETURNED);

      const schema = OWN_SECTION_SCHEMAS[ownSectionOf(before.section)];
      const form = schema.safeParse({ version: 0, ...rawValues });
      if (!form.success) throw inputError(form.error.issues);
      const existing = await loadRecordForWrite(identity.employeeId, session);
      const comparison = await compareSection(
        before.section,
        existing,
        formValuesOf(before.section, form.data),
      );
      if (comparison.fields.length === 0) throw new ActionError(CHANGE_REQUEST_NOTHING_CHANGED);
      checkSectionValues(comparison, existing, businessToday());

      const sendInput: SendChangeRequestInput = {
        current,
        identity,
        section: before.section,
        fields: comparison.fields,
        values: comparison.values,
        note: note === undefined ? before.note : note,
        session,
      };
      const approvalRequestId = await submitFor(before._id, sendInput, before.approvalRequestId);
      const actorId = new Types.ObjectId(current.id);
      const after = (await ChangeRequestModel.findOneAndUpdate(
        { _id: before._id, version: before.version, status: 'returned' },
        {
          $set: {
            changedFields: comparison.fields,
            proposed: await proposedOf(comparison.fields, comparison.values),
            note: sendInput.note,
            status: 'pending',
            sentAt: now(),
            approvalRequestId,
            decidedBy: null,
            decidedAt: null,
            remarks: null,
            updatedBy: actorId,
          },
          $inc: { version: 1 },
        },
        { session, returnDocument: 'after', runValidators: true },
      )
        .select(CHANGE_REQUEST_SENSITIVE_SELECT)
        .lean()) as ChangeRequestDocument | null;
      if (!after) throw new ActionError(RECORD_CHANGED_ELSEWHERE);
      await recordAudit(
        {
          actorId: current.id,
          actorEmail: current.email,
          module: 'talent',
          action: 'update',
          record: {
            type: CHANGE_REQUEST_TYPE,
            id: before._id,
            label: changeRequestAuditLabel(identity.employeeNumber, before.section),
          },
          ...snapshotsForAudit(ChangeRequestModel, before, after),
        },
        { session },
      );
      return { id: before._id.toHexString(), status: after.status };
    });
  } catch (error) {
    if (isOpenRequestConflict(error)) throw new ActionError(CHANGE_REQUEST_ALREADY_OPEN);
    throw error;
  }
}

/**
 * "Cancel request" on a returned request (self-service, the employee's own only): final, never
 * deleted. One `update` entry on `talent.changeRequest`. A pending request can't be cancelled.
 */
export async function cancelChangeRequest(
  actor: TalentActor,
  input: CancelChangeRequestInput,
): Promise<{ id: string; status: ChangeRequestStatus }> {
  const parsed = cancelChangeRequestSchema.safeParse(input);
  if (!parsed.success) throw inputError(parsed.error.issues);
  if (!actor.employee) throw new AccessDeniedError(NO_EMPLOYEE_RECORD);
  await connectDb();
  return withTransaction(async (session) => {
    const { current, identity } = await ownEmployee(actor, session);
    const before = await ownRequest(current, parsed.data.changeRequestId, session);
    if (before.status !== 'returned') throw new ActionError(CHANGE_REQUEST_NOT_RETURNED);
    const after = (await ChangeRequestModel.findOneAndUpdate(
      { _id: before._id, version: before.version, status: 'returned' },
      {
        $set: { status: 'cancelled', updatedBy: new Types.ObjectId(current.id) },
        $inc: { version: 1 },
      },
      { session, returnDocument: 'after', runValidators: true },
    )
      .select(CHANGE_REQUEST_SENSITIVE_SELECT)
      .lean()) as ChangeRequestDocument | null;
    if (!after) throw new ActionError(RECORD_CHANGED_ELSEWHERE);
    await recordAudit(
      {
        actorId: current.id,
        actorEmail: current.email,
        module: 'talent',
        action: 'update',
        record: {
          type: CHANGE_REQUEST_TYPE,
          id: before._id,
          label: changeRequestAuditLabel(identity.employeeNumber, before.section),
        },
        ...snapshotsForAudit(ChangeRequestModel, before, after),
      },
      { session },
    );
    return { id: before._id.toHexString(), status: after.status };
  });
}

// ---------------------------------------------------------------------------------------------
// Reads

/**
 * The signed-in user's own change requests, newest first, for /talent/me's Change requests list
 * (self-service, no employee id). Field labels only, never a value. Empty for the system account.
 */
export async function listOwnChangeRequests(
  actor: TalentActor,
): Promise<OwnChangeRequestListItem[]> {
  const employeeId = objectIdOf(actor.employee?.id);
  if (!employeeId) return [];
  await connectDb();
  const requests = (await ChangeRequestModel.find({ employeeId })
    .sort({ createdAt: -1, _id: -1 })
    .lean()) as ChangeRequestDocument[];
  return requests.map((request) => ({
    id: request._id.toHexString(),
    section: request.section,
    sectionLabel: CHANGE_REQUEST_SECTION_LABELS[request.section],
    status: request.status,
    statusLabel: CHANGE_REQUEST_STATUS_LABELS[request.status],
    sentAt: request.sentAt,
    summary: changeRequestSummary(request.section, request.changedFields as ChangeRequestField[]),
    remarks:
      request.status === 'returned' || request.status === 'rejected' ? request.remarks : null,
    canResend: request.status === 'returned',
    canCancel: request.status === 'returned',
  }));
}

/**
 * The state of each own Edit sheet on /talent/me, by change request section: its open request
 * (Edit opens it instead), and who approves a change, for the footer. The on-screen Personal
 * section holds `contact` and `personal`. Null for the system account.
 */
export async function getOwnChangeRequestStates(
  actor: TalentActor,
): Promise<Record<ChangeRequestSection, OwnSectionEditView> | null> {
  const ownId = actor.employee?.id;
  const employeeId = objectIdOf(ownId);
  if (!ownId || !employeeId) return null;
  await connectDb();
  const [subject, open] = await Promise.all([
    getSensitiveSubject(employeeId),
    ChangeRequestModel.find(
      { employeeId, status: { $in: ['pending', 'returned'] } },
      { section: 1, status: 1 },
    ).lean() as Promise<Pick<ChangeRequestDocument, '_id' | 'section' | 'status'>[]>,
  ]);
  const inHr = subject ? isInHr(subject) : false;
  const sections = ['contact', 'skills', 'personal', 'governmentIds', 'bankAccount'] as const;
  const states = {} as Record<ChangeRequestSection, OwnSectionEditView>;
  for (const section of sections) {
    const request = open.find((entry) => entry.section === section);
    states[section] = {
      openRequest: request
        ? { id: request._id.toHexString(), status: request.status as 'pending' | 'returned' }
        : null,
      approvers: changeRequestApprovers(section, inHr),
    };
  }
  return states;
}

const SENSITIVE_CATEGORY = { governmentIds: 'governmentId', bankAccount: 'bankAccount' } as const;

/** Display text of a field's value (null for none). Never used for a sensitive field. */
function displayOf(field: ChangeRequestField, value: unknown): string | null {
  if (value === null || value === undefined) return null;
  switch (field) {
    case 'dateOfBirth':
      return value instanceof Date ? formatDate(value) : String(value);
    case 'sex':
      return SEX_LABELS[value as Sex] ?? String(value);
    case 'civilStatus':
      return CIVIL_STATUS_LABELS[value as CivilStatus] ?? String(value);
    case 'bank':
      return PAYROLL_BANK_LABELS[value as PayrollBank] ?? String(value);
    case 'skills': {
      const skills = value as string[];
      return skills.length ? skills.join(', ') : null;
    }
    case 'emergencyContact': {
      const contact = value as {
        name?: string | null;
        relationship?: string | null;
        mobileNumber?: string | null;
      };
      const parts = [contact.name, contact.relationship, contact.mobileNumber].filter(
        (part): part is string => typeof part === 'string' && part !== '',
      );
      return parts.length ? parts.join(' · ') : null;
    }
    default:
      return typeof value === 'string' ? value : String(value);
  }
}

async function masked(
  value: unknown,
  ownerType: string,
  ownerId: string,
  field: string,
): Promise<MaskedDigitsView | null> {
  if (value === null || value === undefined) return null;
  return { lastFour: await sensitiveLastFour(value), ownerType, ownerId, field };
}

/** The reveal field of a sensitive record field on `talent.employeeRecord`. */
function recordRevealField(field: ChangeRequestField): string {
  return field === 'accountNumber' ? BANK_ACCOUNT_NUMBER_FIELD : field;
}

/**
 * `/talent/change-requests/<id>`: the request for its requester, its approvers (a supervisor with
 * no module access included), the System Administrator, and Talent Read users who may see that
 * section of the employee's record. Null when there is no such request; AccessDeniedError (the
 * no-access state, HTTP 403) for anyone else. Before a decision the fields show the record's
 * current values beside the proposed ones; once approved, the previous and applied ones. A
 * government ID or account number is masked (last 4) with its Reveal target; a viewer who may not
 * reveal it gets the no-access state instead (the routing never sends them one).
 */
export async function getChangeRequestView(
  actor: TalentActor,
  changeRequestId: string,
): Promise<ChangeRequestView | null> {
  const id = objectIdOf(changeRequestId);
  if (!id) return null;
  await connectDb();
  const request = (await ChangeRequestModel.findById(id)
    .select(CHANGE_REQUEST_SENSITIVE_SELECT)
    .lean()) as ChangeRequestDocument | null;
  if (!request) return null;
  const subject = await getSensitiveSubject(request.employeeId);
  if (!subject) return null;

  const isRequester = request.requesterUserId.toHexString() === actor.id;
  const allowed =
    isRequester ||
    actor.isSystemAdministrator ||
    canSeeChangeRequestSection(actor, request.section, subject) ||
    (await isApproverFor(actor.id, CHANGE_REQUEST_TYPE, request._id.toHexString()));
  if (!allowed) throw new AccessDeniedError(CHANGE_REQUEST_DENIED);
  const sensitiveSection =
    request.section === 'governmentIds' || request.section === 'bankAccount'
      ? SENSITIVE_CATEGORY[request.section]
      : null;
  const canReveal = sensitiveSection ? canRevealSensitive(actor, sensitiveSection, subject) : false;
  if (sensitiveSection && !canReveal) throw new AccessDeniedError(CHANGE_REQUEST_DENIED);

  const approved = request.status === 'approved';
  let record: EmployeeRecordDocument | null = null;
  if (!approved) {
    const query = EmployeeRecordModel.findOne({ employeeId: request.employeeId });
    // The encrypted values only for a sensitive section, whose viewer may reveal them (above).
    if (sensitiveSection) query.select(EMPLOYEE_RECORD_SENSITIVE_SELECT);
    record = (await query.lean()) as EmployeeRecordDocument | null;
  }
  const recordId = record?._id.toHexString() ?? null;
  const requestId = request._id.toHexString();

  const fields: ChangeRequestFieldView[] = [];
  for (const field of request.changedFields as ChangeRequestField[]) {
    const proposedValue = (request.proposed as Record<string, unknown>)[field];
    const currentValue = approved
      ? ((request.previous ?? {}) as Record<string, unknown>)[field]
      : valueAt(record, RECORD_PATHS[field]);
    const view: ChangeRequestFieldView = {
      field,
      label: CHANGE_REQUEST_FIELD_LABELS[field],
      current: null,
      proposed: null,
      sensitive: isSensitiveChangeRequestField(field),
    };
    if (view.sensitive) {
      view.currentMasked = approved
        ? await masked(currentValue, CHANGE_REQUEST_TYPE, requestId, `previous.${field}`)
        : recordId
          ? await masked(currentValue, EMPLOYEE_RECORD_TYPE, recordId, recordRevealField(field))
          : null;
      view.proposedMasked = await masked(
        proposedValue,
        CHANGE_REQUEST_TYPE,
        requestId,
        `proposed.${field}`,
      );
    } else {
      view.current = displayOf(field, currentValue);
      view.proposed = displayOf(field, proposedValue);
    }
    fields.push(view);
  }

  const [employee, names] = await Promise.all([
    employeeAuditLabel(request.employeeId),
    userNames(request.decidedBy ? [request.decidedBy] : []),
  ]);
  return {
    id: requestId,
    employee: {
      id: request.employeeId.toHexString(),
      name: employee?.name ?? 'Unknown employee',
      employeeNumber: employee?.employeeNumber ?? '',
    },
    section: request.section,
    sectionLabel: CHANGE_REQUEST_SECTION_LABELS[request.section],
    status: request.status,
    statusLabel: CHANGE_REQUEST_STATUS_LABELS[request.status],
    sentAt: request.sentAt,
    note: request.note,
    fields,
    remarks: request.remarks,
    // Approved, returned or rejected: who decided and when (cancelled keeps the return's).
    decided:
      request.decidedBy && request.decidedAt
        ? {
            at: request.decidedAt,
            byName: names.get(request.decidedBy.toHexString()) ?? 'Unknown user',
          }
        : null,
    approvalHref: request.approvalRequestId
      ? approvalHref(request.approvalRequestId.toHexString())
      : '/approvals',
    canReveal,
  };
}
