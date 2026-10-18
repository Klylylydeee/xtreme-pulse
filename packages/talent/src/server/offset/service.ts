import type { ClientSession } from 'mongoose';
import { Types } from 'mongoose';
import { connectDb, withTransaction } from '@pulse/db';
import { ActionError, type BusinessDate, businessToday } from '@pulse/core';
import { notify, recordAudit, snapshotForAudit } from '@pulse/core/server';
import {
  assertOffsetEntryMinutes,
  availableOffsetMinutes,
  holidayChangedReason,
  OFFSET_ADJUSTED_EVENT,
  OFFSET_ENTRY_TYPE,
  offsetAdjustedHref,
  offsetAdjustedMessage,
  offsetBalanceMinutes,
  offsetEntryAuditLabel,
  OFFSET_USAGE_SOURCE_TYPE,
  offsetReconcileDifference,
  shouldWriteOffsetCredit,
  TIMESHEET_OFFSET_ENTRY_KINDS,
} from '../../offset/entries';
import type { OffsetAvailableBalanceView, OffsetCreditView } from '../../offset/views';
import { timesheetDtr } from '../dtr/service';
import { isTimeOffApproverOf, pendingOffsetMinutes } from '../leave/holdings';
import type { TalentActor } from '../policy';
import { dayOf, instantOf } from '../shared';
import {
  isTimesheetApprover,
  serviceIdentity,
  timesheetViewerIdentity,
} from '../timesheets/access';
import { type TimesheetDocument, TimesheetModel } from '../timesheets/model';
import { type OffsetEntryDocument, OffsetEntryModel } from './model';

// Spec: docs/modules/talent.md#timesheet-approval-the-dtr-and-the-offset-balance-build-step-27
// ("The offset balance", "The holidays-changed listener"), docs/modules/talent.md#offset-balance--
// offset-time-off, DATA_MODEL.md (`offsetEntries`) and decisions 286, 287 and 292 in
// docs/BUILD_PLAN.md.
//
// - The balance is the sum of the employee's entries, in whole minutes, read when needed and never
//   stored. It isn't sensitive: whoever may see the employee's timesheet sees it.
// - The credit: when HR approves a timesheet, in the decision's transaction, one `credit` of the
//   timesheet's DTR offset total at that moment, dated the approval day, when it is above 0 or the
//   timesheet's extra hours are treated as offset (a 0-minute credit records that it was credited).
//   The partial unique index refuses a second credit. Audit: `create` on `talent.offsetEntry`.
// - The reconcile (the holidays-changed listener `talent.recomputeDtr`): for each approved and
//   credited timesheet whose period holds a changed date, in its own transaction after step 2.4's
//   touch, the DTR's offset total now less the timesheet's credit and adjustments becomes an
//   `adjustment` ("Holiday changed: <dates>"), audited with no actor, and the employee is told with
//   `talent.offsetAdjusted`. Idempotent: a second run finds no difference. Finalized payroll
//   periods included, since offset hours are never pay (*Assumption*, HANDOFF item 133).

/** The offset balance of `employeeId` (signed whole minutes), as of now. */
export async function offsetBalanceOf(
  employeeId: string | Types.ObjectId,
  session: ClientSession | null = null,
): Promise<number> {
  await connectDb();
  const id = typeof employeeId === 'string' ? new Types.ObjectId(employeeId) : employeeId;
  const entries = await OffsetEntryModel.find({ employeeId: id }, { minutes: 1 })
    .session(session)
    .lean<Pick<OffsetEntryDocument, 'minutes'>[]>();
  return offsetBalanceMinutes(entries);
}

/** The timesheet's credit and adjustments, oldest first. */
async function timesheetEntries(
  timesheetId: Types.ObjectId,
  session: ClientSession | null = null,
): Promise<OffsetEntryDocument[]> {
  return OffsetEntryModel.find({
    timesheetId,
    kind: { $in: [...TIMESHEET_OFFSET_ENTRY_KINDS] },
  })
    .sort({ createdAt: 1, _id: 1 })
    .session(session)
    .lean<OffsetEntryDocument[]>();
}

/**
 * The timesheet's credit once HR approved it: the credit plus any later adjustments, and the
 * credit's day ("Credited +4.6 h on Sep 28"). Null before it is credited.
 */
export async function timesheetOffsetCredit(
  timesheetId: string | Types.ObjectId,
  session: ClientSession | null = null,
): Promise<OffsetCreditView | null> {
  await connectDb();
  const id = typeof timesheetId === 'string' ? new Types.ObjectId(timesheetId) : timesheetId;
  const entries = await timesheetEntries(id, session);
  const credit = entries.find((entry) => entry.kind === 'credit');
  if (!credit) return null;
  return {
    minutes: entries.reduce((sum, entry) => sum + entry.minutes, 0),
    creditedOn: dayOf(credit.effectiveOn),
  };
}

/** Who wrote an entry: the deciding user, or null for the system. */
export interface EntryAuthor {
  userId: string;
  email: string;
}

async function insertEntry(
  values: Pick<
    OffsetEntryDocument,
    'employeeId' | 'kind' | 'minutes' | 'timesheetId' | 'reason'
  > & {
    effectiveOn: BusinessDate;
    /** Step 2.8: the time off request of a usage entry. */
    requestId?: Types.ObjectId | null;
  },
  label: string,
  author: EntryAuthor | null,
  session: ClientSession,
): Promise<OffsetEntryDocument> {
  assertOffsetEntryMinutes(values.kind, values.minutes);
  const { requestId = null, ...stored } = values;
  const by = author ? new Types.ObjectId(author.userId) : null;
  const entry = new OffsetEntryModel({
    ...stored,
    effectiveOn: instantOf(values.effectiveOn),
    sourceType: requestId ? OFFSET_USAGE_SOURCE_TYPE : null,
    sourceId: requestId,
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
      record: { type: OFFSET_ENTRY_TYPE, id: entry._id, label },
      before: null,
      after: snapshotForAudit(OffsetEntryModel, entry),
      reason: values.reason,
    },
    { session },
  );
  return entry.toObject() as OffsetEntryDocument;
}

/**
 * HR approved `timesheet`: writes its `credit`, in the decision's transaction (decision 287). The
 * total is the DTR's offset total at this moment (the sum of each day's rounded offset). Nothing is
 * written for a timesheet whose extra hours are overtime and that earned no offset. Returns the
 * entry, or null when none was written.
 */
export async function writeOffsetCredit(
  timesheet: TimesheetDocument,
  author: EntryAuthor,
  session: ClientSession,
): Promise<OffsetEntryDocument | null> {
  const identity = await serviceIdentity(timesheet.employeeId.toHexString(), { session });
  if (!identity) throw new Error('The employee of this timesheet no longer exists.');
  const today = businessToday();
  const { dtr } = await timesheetDtr(timesheet, identity, { session, today });
  const minutes = dtr.totals.offsetMinutes;
  if (!shouldWriteOffsetCredit(minutes, dtr.treatment)) return null;
  return insertEntry(
    {
      employeeId: timesheet.employeeId,
      kind: 'credit',
      minutes,
      timesheetId: timesheet._id,
      reason: null,
      effectiveOn: today,
    },
    offsetEntryAuditLabel(identity.employeeNumber, today),
    author,
    session,
  );
}

// ---------------------------------------------------------------------------------------------
// The holidays-changed reconcile

export interface OffsetReconcileResult {
  /** Approved timesheets whose period holds a changed date. */
  timesheets: number;
  /** Adjustments written in this run. */
  adjusted: number;
}

/** Reconciles one approved timesheet in its own transaction; true when it wrote an adjustment. */
async function reconcileTimesheet(
  timesheetId: Types.ObjectId,
  dates: readonly BusinessDate[],
): Promise<boolean> {
  return withTransaction(async (session) => {
    const timesheet = await TimesheetModel.findById(timesheetId)
      .session(session)
      .lean<TimesheetDocument>();
    if (!timesheet || timesheet.status !== 'approved') return false;
    const entries = await timesheetEntries(timesheetId, session);
    // Only a credited timesheet is reconciled: one with no credit earned none to adjust.
    if (!entries.some((entry) => entry.kind === 'credit')) return false;
    const identity = await serviceIdentity(timesheet.employeeId.toHexString(), { session });
    if (!identity) return false;

    const today = businessToday();
    const { dtr } = await timesheetDtr(timesheet, identity, { session, today });
    const difference = offsetReconcileDifference(dtr.totals.offsetMinutes, entries);
    if (difference === 0) return false;

    // Step 2.4's touch, only when an adjustment is written: another run on the same timesheet
    // then conflicts and retries, re-reading the entries this run wrote, so it stays idempotent.
    await TimesheetModel.updateOne(
      { _id: timesheetId },
      { $set: { updatedBy: null }, $inc: { __v: 1 } },
      { session },
    );

    const periodStart = dayOf(timesheet.periodStart);
    const periodEnd = dayOf(timesheet.periodEnd);
    const changed = dates.filter((date) => date >= periodStart && date <= periodEnd);
    const entry = await insertEntry(
      {
        employeeId: timesheet.employeeId,
        kind: 'adjustment',
        minutes: difference,
        timesheetId: timesheet._id,
        reason: holidayChangedReason(changed),
        effectiveOn: today,
      },
      offsetEntryAuditLabel(identity.employeeNumber, today),
      null,
      session,
    );
    if (identity.userId && identity.active && !identity.separated) {
      await notify(
        {
          recipients: [identity.userId],
          module: 'talent',
          event: OFFSET_ADJUSTED_EVENT,
          title: offsetAdjustedMessage(difference, changed),
          href: offsetAdjustedHref(identity.employeeId, periodStart),
          record: { type: OFFSET_ENTRY_TYPE, id: entry._id },
        },
        { session },
      );
    }
    return true;
  });
}

/**
 * The holidays-changed listener's work (decision 292): reconciles the offset credits of approved
 * timesheets whose period holds one of `dates`. Timesheets not yet approved need nothing: their DTR
 * is read fresh, and their credit is computed at HR's approval. Idempotent.
 */
export async function reconcileOffsetCredits(
  dates: readonly BusinessDate[],
): Promise<OffsetReconcileResult> {
  const sorted = [...new Set(dates)].sort();
  const first = sorted[0];
  const last = sorted[sorted.length - 1];
  if (!first || !last) return { timesheets: 0, adjusted: 0 };
  await connectDb();
  const candidates = await TimesheetModel.find(
    {
      status: 'approved',
      periodStart: { $lte: instantOf(last) },
      periodEnd: { $gte: instantOf(first) },
    },
    { periodStart: 1, periodEnd: 1 },
  ).lean<Pick<TimesheetDocument, '_id' | 'periodStart' | 'periodEnd'>[]>();
  const affected = candidates.filter((timesheet) => {
    const start = dayOf(timesheet.periodStart);
    const end = dayOf(timesheet.periodEnd);
    return sorted.some((date) => date >= start && date <= end);
  });
  let adjusted = 0;
  for (const timesheet of affected) {
    if (await reconcileTimesheet(timesheet._id, sorted)) adjusted += 1;
  }
  return { timesheets: affected.length, adjusted };
}

// ---------------------------------------------------------------------------------------------
// getOffsetBalance

/**
 * The offset balance of `employeeId` (Talent's service for steps 2.8, 2.9 and 2.13), for whoever
 * may see the employee's timesheet: the employee, Talent Read, a `reportingTo` supervisor, an
 * approver of one of their timesheets, or (step 2.8) of one of their time off requests. Anyone
 * else gets AccessDeniedError. Null when there is no such employee. It may be below zero after an
 * adjustment. From step 2.8 it also carries what pending offset time off holds and the available
 * balance (decision 312).
 */
export async function getOffsetBalance(
  actor: TalentActor,
  employeeId: string,
): Promise<OffsetAvailableBalanceView | null> {
  await connectDb();
  const viewer = await timesheetViewerIdentity(actor, employeeId, async (identity) => {
    const submitted = await TimesheetModel.find(
      { employeeId: new Types.ObjectId(identity.employeeId), approvalRequestId: { $ne: null } },
      { _id: 1 },
    ).lean<{ _id: Types.ObjectId }[]>();
    for (const timesheet of submitted) {
      if (await isTimesheetApprover(actor.id, timesheet._id.toHexString())) return true;
    }
    return isTimeOffApproverOf(actor.id, identity.employeeId);
  });
  if (!viewer) return null;
  const id = viewer.identity.employeeId;
  const [balanceMinutes, pending] = await Promise.all([
    offsetBalanceOf(id),
    pendingOffsetMinutes(id),
  ]);
  return {
    employeeId: id,
    balanceMinutes,
    pendingMinutes: pending.reduce((sum, minutes) => sum + minutes, 0),
    availableMinutes: availableOffsetMinutes(balanceMinutes, pending),
  };
}

// ---------------------------------------------------------------------------------------------
// Step 2.8: the available balance, usage, opening and HR's correction (decisions 303, 307, 312,
// 314 and 316). Each writer runs in the caller's transaction with its `create` audit entry on
// `talent.offsetEntry` (labelled `<employee number> · <YYYY-MM-DD>`).

/**
 * The available offset balance (decision 312): the balance less the minutes of the employee's
 * other pending offset time off. `exceptRequestId` leaves out the request being filed again or
 * approved. At or below zero, no offset time off may be filed.
 */
export async function availableOffsetMinutesOf(
  employeeId: string | Types.ObjectId,
  {
    exceptRequestId = null,
    session = null,
  }: { exceptRequestId?: string | Types.ObjectId | null; session?: ClientSession | null } = {},
): Promise<number> {
  const [balance, pending] = await Promise.all([
    offsetBalanceOf(employeeId, session),
    pendingOffsetMinutes(employeeId, { exceptRequestId, session }),
  ]);
  return availableOffsetMinutes(balance, pending);
}

async function employeeNumberOf(employeeId: string, session: ClientSession): Promise<string> {
  const identity = await serviceIdentity(employeeId, { session });
  if (!identity) throw new ActionError('This employee no longer exists. Reload the page.');
  return identity.employeeNumber;
}

/**
 * The time off service's offset `usage` entry, in the decision's, cancel's or listener's
 * transaction: minus the request's minutes at approval, plus them back on a cancel or when a
 * holiday change lowers them, minus more when it raises them (even below zero, decision 316).
 * `sourceType` `talent.timeOffRequest` and `sourceId` the request. 0 writes nothing (null).
 */
export async function writeOffsetUsage(
  input: {
    employeeId: string;
    /** Signed whole minutes. */
    minutes: number;
    effectiveOn: BusinessDate;
    requestId: string | Types.ObjectId;
    /** The listener's "Holiday changed: <dates>", or null. */
    reason?: string | null;
  },
  author: EntryAuthor | null,
  session: ClientSession,
): Promise<OffsetEntryDocument | null> {
  if (input.minutes === 0) return null;
  return insertEntry(
    {
      employeeId: new Types.ObjectId(input.employeeId),
      kind: 'usage',
      minutes: input.minutes,
      timesheetId: null,
      reason: input.reason ?? null,
      effectiveOn: input.effectiveOn,
      requestId:
        typeof input.requestId === 'string' ? new Types.ObjectId(input.requestId) : input.requestId,
    },
    offsetEntryAuditLabel(await employeeNumberOf(input.employeeId, session), input.effectiveOn),
    author,
    session,
  );
}

/**
 * HR's `opening` (0 or more, dated the go-live date) or `adjustment` (signed, with a reason),
 * written by the opening balance service after its checks. A second opening fails with the
 * duplicate key error of the unique index.
 */
export async function writeOffsetHrEntry(
  input: {
    employeeId: string;
    employeeNumber: string;
    kind: 'opening' | 'adjustment';
    minutes: number;
    effectiveOn: BusinessDate;
    reason: string | null;
  },
  author: EntryAuthor,
  session: ClientSession,
): Promise<OffsetEntryDocument> {
  return insertEntry(
    {
      employeeId: new Types.ObjectId(input.employeeId),
      kind: input.kind,
      minutes: input.minutes,
      timesheetId: null,
      reason: input.reason,
      effectiveOn: input.effectiveOn,
    },
    offsetEntryAuditLabel(input.employeeNumber, input.effectiveOn),
    author,
    session,
  );
}
