import { type ClientSession, Types } from 'mongoose';
import { connectDb } from '@pulse/db';
import { AccessDeniedError, ActionError, type BusinessDate, businessToday } from '@pulse/core';
import {
  type EmployeeIdentity,
  getEmployeeIdentity,
  isHR,
  isSystemAdministrator,
  recordAudit,
  snapshotForAudit,
} from '@pulse/core/server';
import {
  assertLeaveEntryHalfDays,
  availableLeaveHalfDays,
  leaveBalanceHalfDays,
} from '../../time-off/balance';
import { LEAVE_ENTRY_TYPE, type LeaveEntryKind, TIME_OFF_REQUEST_TYPE } from '../../time-off/kinds';
import { type LeaveSettings, type LeaveType, leaveTypeOf } from '../../time-off/settings';
import { halfDaysOf } from '../../time-off/units';
import {
  canSeeConfidentialLeave,
  type LeaveBalancesView,
  type LeaveBalanceView,
  type LeaveEntryView,
  leaveEntryAuditLabel,
  type PerYearLeaveUsageView,
} from '../../time-off/views';
import { EmployeeRecordModel } from '../employee-records/model';
import { leaveSettingsOn } from '../payroll-settings/settings';
import { canViewTimesheet, type TalentActor } from '../policy';
import { dayOf, instantOf } from '../shared';
import { serviceIdentity } from '../timesheets/access';
import { isTimeOffApproverOf, pendingLeavePaidHalfDays, perYearUsedHalfDays } from './holdings';
import { type LeaveEntryDocument, LeaveEntryModel } from './model';

// Spec: docs/modules/talent.md#leave-offset-time-off-and-opening-balances-build-step-28 ("Leave
// entries", "Insufficient balance", "Who may see what", "Cross-module and services"), DATA_MODEL.md
// (`leaveEntries`) and decisions 303, 307, 311, 318 and 320 in docs/BUILD_PLAN.md.
//
// - A `credited` type's balance is the sum of the employee's entries for it, in whole half days,
//   read when needed and never stored. The available balance is the balance, never counting a
//   credit dated after today, less the paid half days of the employee's other pending requests.
// - Every entry is written here, in the caller's transaction, with its `create` audit entry on
//   `talent.leaveEntry` labelled `<employee number> · <short name> · <YYYY-MM-DD>` (no amount).
//   The writers the time off service calls: `writeLeaveUsage` at approval and cancel, and
//   `writeLeaveAdjustment` for the holidays-changed listener. HR's opening and correction go
//   through server/opening-balances/, the credit job through ./credits.ts.
// - `getLeaveBalances`: requests and balances aren't sensitive. The employee, Talent Read, a
//   `reportingTo` supervisor and anyone who is or was an approver on one of the employee's
//   requests see them read-only, whatever their module access. A confidential type (VAWC) is left
//   out for anyone but the employee, HR and the System Administrator.

export const TIME_OFF_DENIED = 'You don’t have access to this employee’s time off.';
export const LEAVE_TYPE_NOT_CREDITED = 'Choose vacation or sick leave, or another credited type.';

/** Who wrote an entry: the signed-in user, or null for the system (the job and the listener). */
export interface EntryAuthor {
  userId: string;
  email: string;
}

function idOf(id: string | Types.ObjectId): Types.ObjectId {
  return typeof id === 'string' ? new Types.ObjectId(id) : id;
}

/** What a new leave entry holds. */
export interface LeaveEntryValues {
  employeeId: string | Types.ObjectId;
  typeKey: string;
  kind: LeaveEntryKind;
  halfDays: number;
  effectiveOn: BusinessDate;
  /** The credit's or carry-over's year; null for the other kinds. */
  year?: number | null;
  /** A time off request's id (a usage, or the listener's adjustment). */
  requestId?: string | Types.ObjectId | null;
  reason?: string | null;
}

/** The audit label's parts, read by the caller (who usually has them already). */
export interface LeaveEntryLabel {
  employeeNumber: string;
  shortName: string;
}

/**
 * Inserts one leave entry with its `create` audit entry, in `session`. Throws RangeError when the
 * half days don't fit the kind, or when a year is missing on a credit or carry-over (or set on
 * another kind). A duplicate opening, credit or carry-over fails with MongoDB's duplicate key
 * error, which the callers turn into their own answer.
 */
export async function insertLeaveEntry(
  values: LeaveEntryValues,
  label: LeaveEntryLabel,
  author: EntryAuthor | null,
  session: ClientSession,
): Promise<LeaveEntryDocument> {
  assertLeaveEntryHalfDays(values.kind, values.halfDays);
  const yearly = values.kind === 'credit' || values.kind === 'carryOver';
  const year = values.year ?? null;
  if (yearly !== (year !== null)) {
    throw new RangeError('Only a credit or a carry-over has a year, and both need one.');
  }
  const by = author ? new Types.ObjectId(author.userId) : null;
  const entry = new LeaveEntryModel({
    employeeId: idOf(values.employeeId),
    typeKey: values.typeKey,
    kind: values.kind,
    halfDays: values.halfDays,
    effectiveOn: instantOf(values.effectiveOn),
    year,
    sourceType: values.requestId ? TIME_OFF_REQUEST_TYPE : null,
    sourceId: values.requestId ? idOf(values.requestId) : null,
    reason: values.reason ?? null,
    createdBy: by,
    updatedBy: by,
  });
  await entry.save({ session });
  await recordAudit(
    {
      actorId: author?.userId ?? null,
      actorEmail: author?.email ?? null,
      module: 'talent',
      action: 'create',
      record: {
        type: LEAVE_ENTRY_TYPE,
        id: entry._id,
        label: leaveEntryAuditLabel(label.employeeNumber, label.shortName, values.effectiveOn),
      },
      before: null,
      after: snapshotForAudit(LeaveEntryModel, entry),
      reason: values.reason ?? null,
    },
    { session },
  );
  return entry.toObject() as LeaveEntryDocument;
}

/** The employee's entries for one type (every type when `typeKey` is null), oldest first. */
export async function leaveEntriesOf(
  employeeId: string | Types.ObjectId,
  typeKey: string | null,
  { session = null }: { session?: ClientSession | null } = {},
): Promise<LeaveEntryDocument[]> {
  await connectDb();
  return LeaveEntryModel.find({
    employeeId: idOf(employeeId),
    ...(typeKey === null ? {} : { typeKey }),
  })
    .sort({ effectiveOn: 1, createdAt: 1, _id: 1 })
    .session(session)
    .lean<LeaveEntryDocument[]>();
}

const sumsOf = (entries: readonly LeaveEntryDocument[]) =>
  entries.map((entry) => ({
    kind: entry.kind,
    halfDays: entry.halfDays,
    effectiveOn: dayOf(entry.effectiveOn),
  }));

/** A `credited` type's balance (signed whole half days), the sum of every entry. */
export async function leaveBalanceOf(
  employeeId: string | Types.ObjectId,
  typeKey: string,
  options: { session?: ClientSession | null } = {},
): Promise<number> {
  return leaveBalanceHalfDays(await leaveEntriesOf(employeeId, typeKey, options));
}

/**
 * A `credited` type's available balance (decision 311): the balance, never counting a credit or
 * carry-over dated after `today`, less the paid half days of the employee's other pending
 * requests of the type. `exceptRequestId` leaves out the request being filed again or approved.
 */
export async function availableLeaveHalfDaysOf(
  employeeId: string | Types.ObjectId,
  typeKey: string,
  {
    today = businessToday(),
    exceptRequestId = null,
    session = null,
  }: {
    today?: BusinessDate;
    exceptRequestId?: string | Types.ObjectId | null;
    session?: ClientSession | null;
  } = {},
): Promise<number> {
  const [entries, pending] = await Promise.all([
    leaveEntriesOf(employeeId, typeKey, { session }),
    pendingLeavePaidHalfDays(employeeId, typeKey, { exceptRequestId, session }),
  ]);
  return availableLeaveHalfDays({ entries: sumsOf(entries), today, pendingPaidHalfDays: pending });
}

/** The label parts for an employee's entry: the employee number and the type's short name. */
async function labelOf(
  employeeId: string,
  typeKey: string,
  session: ClientSession,
  settings?: LeaveSettings,
): Promise<LeaveEntryLabel> {
  const identity = await serviceIdentity(employeeId, { session });
  if (!identity) throw new ActionError('This employee no longer exists. Reload the page.');
  const types = settings ?? (await leaveSettingsOn(businessToday(), { session }));
  return {
    employeeNumber: identity.employeeNumber,
    shortName: leaveTypeOf(types, typeKey)?.shortName ?? typeKey,
  };
}

/**
 * The time off service's usage entry (decision 314), in the decision's or the cancel's
 * transaction: minus the request's paid half days at approval, plus them back on a cancel. A
 * request with no paid half days writes nothing (returns null). `author` is the approver or the
 * employee cancelling.
 */
export async function writeLeaveUsage(
  input: {
    employeeId: string;
    typeKey: string;
    /** Signed: negative at approval, positive on a cancel. */
    halfDays: number;
    effectiveOn: BusinessDate;
    requestId: string | Types.ObjectId;
  },
  author: EntryAuthor | null,
  session: ClientSession,
): Promise<LeaveEntryDocument | null> {
  if (input.halfDays === 0) return null;
  return insertLeaveEntry(
    { ...input, kind: 'usage' },
    await labelOf(input.employeeId, input.typeKey, session),
    author,
    session,
  );
}

/**
 * An `adjustment` entry, in the caller's transaction: the holidays-changed listener's (with the
 * request's id and a reason such as "Holiday changed: 2026-11-30", no author), or HR's correction
 * (with its required reason, through server/opening-balances/). 0 writes nothing (returns null).
 */
export async function writeLeaveAdjustment(
  input: {
    employeeId: string;
    typeKey: string;
    halfDays: number;
    effectiveOn: BusinessDate;
    reason: string;
    requestId?: string | Types.ObjectId | null;
  },
  author: EntryAuthor | null,
  session: ClientSession,
): Promise<LeaveEntryDocument | null> {
  if (input.halfDays === 0) return null;
  return insertLeaveEntry(
    { ...input, kind: 'adjustment' },
    await labelOf(input.employeeId, input.typeKey, session),
    author,
    session,
  );
}

// ---------------------------------------------------------------------------------------------
// Who may see an employee's time off

/**
 * The employee whose time off `actor` opens: the employee, Talent Read, a `reportingTo`
 * supervisor, or (when those fail) anyone who is or was an approver on one of the employee's
 * requests, read-only (decision 318). Null when there is no such employee for a viewer who may
 * look; {@link AccessDeniedError} otherwise.
 */
export async function timeOffViewerIdentity(
  actor: TalentActor,
  employeeId: string,
): Promise<{ identity: EmployeeIdentity; approver: boolean } | null> {
  let identity: EmployeeIdentity | null = null;
  let denied = false;
  try {
    identity = await getEmployeeIdentity(actor, employeeId, { separated: true });
  } catch (error) {
    if (!(error instanceof AccessDeniedError)) throw error;
    denied = true;
  }
  if (identity && canViewTimesheet(actor, identity)) return { identity, approver: false };
  const subject = await serviceIdentity(employeeId);
  if (!subject) {
    if (denied || identity) throw new AccessDeniedError(TIME_OFF_DENIED);
    return null;
  }
  if (await isTimeOffApproverOf(actor.id, subject.employeeId)) {
    return { identity: subject, approver: true };
  }
  throw new AccessDeniedError(TIME_OFF_DENIED);
}

/** True when `actor` sees confidential types for `employeeId`: the employee, HR, the System Administrator. */
export function canSeeConfidentialFor(actor: TalentActor, employeeId: string): boolean {
  return canSeeConfidentialLeave({
    isEmployee: actor.employee?.id === employeeId,
    isHr: isHR(actor),
    isSystemAdministrator: isSystemAdministrator(actor),
  });
}

/** The `credited` types with a card: the active ones, and a retired one the employee has entries for. */
function creditedTypesFor(settings: LeaveSettings, entryTypeKeys: Set<string>): LeaveType[] {
  return settings.types.filter(
    (type) => type.balance === 'credited' && (type.active || entryTypeKeys.has(type.key)),
  );
}

/** A Regular employee with no regularization date (the inspector's flag). */
export async function isRegularizationDateMissing(identity: EmployeeIdentity): Promise<boolean> {
  if (identity.employmentStatus !== 'Regular') return false;
  const record = await EmployeeRecordModel.findOne(
    { employeeId: new Types.ObjectId(identity.employeeId) },
    { regularizationDate: 1 },
  ).lean<{ regularizationDate: Date | null } | null>();
  return !record?.regularizationDate;
}

/**
 * `getLeaveBalances` (Talent's service for steps 2.9, 2.13 and 2.16, and the time off pages): the
 * employee's `credited` balances with what pending requests hold, the `perYear` types' use this
 * year, and the regularization flag. For whoever may see the employee's time off
 * ({@link timeOffViewerIdentity}); null when there is no such employee.
 */
export async function getLeaveBalances(
  actor: TalentActor,
  employeeId: string,
): Promise<LeaveBalancesView | null> {
  await connectDb();
  const viewer = await timeOffViewerIdentity(actor, employeeId);
  if (!viewer) return null;
  const { identity } = viewer;
  const today = businessToday();
  const year = Number(today.slice(0, 4));
  const settings = await leaveSettingsOn(today);
  const seeConfidential = canSeeConfidentialFor(actor, identity.employeeId);
  const visible = (type: LeaveType) => seeConfidential || !type.confidential;

  const entries = await leaveEntriesOf(identity.employeeId, null);
  const byType = new Map<string, LeaveEntryDocument[]>();
  for (const entry of entries) {
    byType.set(entry.typeKey, [...(byType.get(entry.typeKey) ?? []), entry]);
  }
  const credited = creditedTypesFor(settings, new Set(byType.keys())).filter(visible);

  const balances = await Promise.all(
    credited.map(async (type): Promise<LeaveBalanceView> => {
      const own = byType.get(type.key) ?? [];
      const pending = await pendingLeavePaidHalfDays(identity.employeeId, type.key);
      return {
        typeKey: type.key,
        name: type.name,
        shortName: type.shortName,
        balanceHalfDays: leaveBalanceHalfDays(own),
        availableHalfDays: availableLeaveHalfDays({
          entries: sumsOf(own),
          today,
          pendingPaidHalfDays: pending,
        }),
        pendingHalfDays: pending.reduce((sum, value) => sum + value, 0),
      };
    }),
  );
  const perYear = await Promise.all(
    settings.types
      .filter((type) => type.balance === 'perYear' && type.active && visible(type))
      .map(async (type): Promise<PerYearLeaveUsageView> => ({
        typeKey: type.key,
        name: type.name,
        shortName: type.shortName,
        year,
        usedHalfDays: await perYearUsedHalfDays(identity.employeeId, type.key, year),
        limitHalfDays: halfDaysOf(type.days),
      })),
  );
  return {
    employeeId: identity.employeeId,
    balances,
    perYear,
    regularizationDateMissing:
      settings.types.some((type) => type.balance === 'credited' && type.active) &&
      (await isRegularizationDateMissing(identity)),
  };
}

/**
 * The employee's leave entries, newest first, for the inspector's Time off section and the
 * opening balances sheet: the same viewers as {@link getLeaveBalances}, with a confidential
 * type's entries left out for anyone but the employee, HR and the System Administrator. Each
 * entry's reason is shown (it isn't sensitive; HR writes it for the employee's file).
 */
export async function listLeaveEntries(
  actor: TalentActor,
  employeeId: string,
): Promise<LeaveEntryView[] | null> {
  await connectDb();
  const viewer = await timeOffViewerIdentity(actor, employeeId);
  if (!viewer) return null;
  const settings = await leaveSettingsOn();
  const seeConfidential = canSeeConfidentialFor(actor, viewer.identity.employeeId);
  const entries = await leaveEntriesOf(viewer.identity.employeeId, null);
  return entries
    .filter((entry) => seeConfidential || !leaveTypeOf(settings, entry.typeKey)?.confidential)
    .reverse()
    .map((entry) => ({
      id: entry._id.toHexString(),
      typeKey: entry.typeKey,
      kind: entry.kind,
      halfDays: entry.halfDays,
      effectiveOn: dayOf(entry.effectiveOn),
      year: entry.year,
      reason: entry.reason,
      sourceId: entry.sourceId?.toHexString() ?? null,
      createdAt: entry.createdAt,
    }));
}
