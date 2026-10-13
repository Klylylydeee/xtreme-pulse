import { type ClientSession, Types } from 'mongoose';
import { connectDb, withTransaction } from '@pulse/db';
import {
  AccessDeniedError,
  ActionError,
  addDays,
  type BusinessDate,
  businessToday,
  formatDate,
  isBusinessDate,
  now,
} from '@pulse/core';
import {
  type EmployeeIdentity,
  getEmployeeIdentity,
  listClientOptions,
  listConfigVersions,
  listConfirmedHolidays,
  listDirectReportIdentities,
  recordAudit,
  reloadActorAccess,
  snapshotForAudit,
  snapshotsForAudit,
  toDirectoryIdentity,
} from '@pulse/core/server';
import {
  computeTimesheet,
  dayKindLabel,
  epochMinuteOf,
  manilaDateOf,
  manilaDayStartMinute,
  type TimesheetDayHours,
} from '../../timesheets/compute';
import {
  type CreateTimeEntryInput,
  createTimeEntrySchema,
  type DeleteTimeEntryInput,
  deleteTimeEntrySchema,
  type TimeOutInput,
  timeOutSchema,
  type UpdateTimeEntryInput,
  updateTimeEntrySchema,
} from '../../timesheets/inputs';
import { scheduleOn } from '../../timesheets/schedule';
import {
  MINUTES_PER_DAY,
  minutesOfClockTime,
  scheduledMinutes,
  type TimeEntrySource,
} from '../../timesheets/schemas';
import {
  STALE_ENTRY_MESSAGE,
  type TeamMemberLink,
  TIME_ENTRY_TYPE,
  type TimeEntryView,
  type TimeInResult,
  type TimeOutResult,
  type TimesheetDayView,
  type TimesheetRecordView,
  type TimesheetTodayView,
  type TimesheetView,
} from '../../timesheets/views';
import { inputError } from '../input';
import { PREMIUM_RATES_SETTING, TIMESHEET_SETTINGS_SETTING } from '../payroll-settings/settings';
import { reimbursementsSectionFor } from '../reimbursements/service';
import { assertCanViewTimesheet, NO_EMPLOYEE_TIMESHEET, type TalentActor } from '../policy';
import { auditLabelOf, dayOf, EMPLOYEE_GONE, instantOf } from '../shared';
import {
  listCompanyScheduleVersions,
  loadWorkScheduleAssignments,
} from '../work-schedules/service';
import {
  type TimeEntryDocument,
  type TimesheetDocument,
  TimeEntryModel,
  TimesheetModel,
} from './model';
import {
  ensureTimesheet,
  loadPayrollVersions,
  OTHER_POSITION_MISSING,
  type PayrollVersions,
  periodOrNull,
} from './periods';

// Spec: docs/modules/talent.md#work-schedules-and-daily-time-entries-build-step-24 ("Time
// entries", "Who may do what", "Screens"), SECURITY.md#exceptions-to-module-access ("The own
// timesheet", "Supervisors see their team's timesheets"), decisions 217–222 and 231 in
// docs/BUILD_PLAN.md.
//
// - Every change is self-service: it acts on the signed-in user's own employee, read from the
//   database in the transaction, never from the request. Nobody changes another person's entries,
//   HR and the System Administrator included: another person's entry is simply not found.
// - Time in and Time out use the server's clock and store `clock`; a typed or changed time is
//   `manual`. The browser never sends a source.
// - Checks, in the save's transaction: the time out after the time in, at most 24 hours, nothing
//   in the future, the date between the date hired and the separation date (and not after today),
//   no overlap with the employee's other entries, one open entry at most, the timesheet open, an
//   activity once there is a time out, and the entry's `version`.
// - Each save touches the timesheets an overlapping entry could belong to, so two saves of the
//   same employee at once conflict and the transaction retries with the other's entry visible.
// - Audit: `create`, `update` and `delete` on `talent.timeEntry`, labelled
//   `<employee number> · <YYYY-MM-DD>`, in the same transaction. No notification.
// - The reads compute hours for display with `computeTimesheet`; nothing computed is stored.

const MS_PER_MINUTE = 60_000;
const MAX_ENTRY_MINUTES = MINUTES_PER_DAY;

export const ENTRY_NOT_FOUND = 'This entry can’t be found. Reload to see it.';
export const ALREADY_TIMED_IN = 'You’re already timed in. Time out first.';
export const NOT_TIMED_IN = 'You aren’t timed in.';
export const ACTIVITY_REQUIRED = 'Enter the activity performed.';
export const TIMESHEET_NOT_OPEN = 'This timesheet is no longer open, so its entries can’t change.';

// ---------------------------------------------------------------------------------------------
// Helpers

/** The instant of `HH:MM` on a Manila day. */
function instantAt(day: BusinessDate, time: string): Date {
  return new Date((manilaDayStartMinute(day) + minutesOfClockTime(time)) * MS_PER_MINUTE);
}

function nameOf(identity: { firstName: string; lastName: string }): string {
  return `${identity.firstName} ${identity.lastName}`;
}

function entryLabel(employeeNumber: string, date: BusinessDate): string {
  return auditLabelOf(employeeNumber, date);
}

interface OwnContext {
  current: Awaited<ReturnType<typeof reloadActorAccess>>;
  identity: EmployeeIdentity;
}

/** Refuses an actor with no employee before any work. */
function assertHasEmployee(actor: TalentActor): void {
  if (!actor.employee) throw new AccessDeniedError(NO_EMPLOYEE_TIMESHEET);
}

/** The actor and their own employee, as they are now, in the transaction. */
async function ownContext(actor: TalentActor, session: ClientSession): Promise<OwnContext> {
  const current = await reloadActorAccess({ id: actor.id }, session);
  if (!current.employee) throw new AccessDeniedError(NO_EMPLOYEE_TIMESHEET);
  const identity = await getEmployeeIdentity(current, current.employee.id, {
    separated: true,
    session,
  });
  if (!identity) throw new ActionError(EMPLOYEE_GONE);
  return { current, identity };
}

/** Touches the employee's existing timesheets of the cut-offs around `date` (see the header). */
async function touchTimesheets(
  employeeId: Types.ObjectId,
  days: BusinessDate[],
  payrollVersions: PayrollVersions,
  actorId: string,
  session: ClientSession,
): Promise<void> {
  const starts = new Set<BusinessDate>();
  for (const day of days) {
    const period = periodOrNull(day, payrollVersions);
    if (period) starts.add(period.start);
  }
  for (const start of starts) {
    // `$inc` always changes the document. A `$set` of values it already holds (the same actor and
    // the same `updatedAt` millisecond) is a no-op that MongoDB doesn't write, so it wouldn't
    // conflict with the other transaction.
    await TimesheetModel.updateOne(
      { employeeId, periodStart: instantOf(start) },
      { $set: { updatedBy: new Types.ObjectId(actorId) }, $inc: { __v: 1 } },
      { session },
    );
  }
}

interface EntryTimes {
  timeIn: Date;
  timeOut: Date | null;
}

/**
 * Every rule of an entry's times and date, then its open timesheet (created on first use). Also
 * touches the timesheets around it. Returns the timesheet and the entry's date.
 */
async function checkEntry(
  { current, identity }: OwnContext,
  times: EntryTimes,
  { excludeId, session }: { excludeId?: Types.ObjectId; session: ClientSession },
): Promise<{ timesheet: TimesheetDocument; date: BusinessDate }> {
  const { timeIn, timeOut } = times;
  const at = now();
  const today = businessToday();
  const date = manilaDateOf(timeIn);

  if (timeOut) {
    if (timeOut.getTime() <= timeIn.getTime()) {
      throw new ActionError('The time out must be after the time in.', { field: 'timeOut' });
    }
    if (epochMinuteOf(timeOut) - epochMinuteOf(timeIn) > MAX_ENTRY_MINUTES) {
      throw new ActionError('An entry can last at most 24 hours.', { field: 'timeOut' });
    }
  }
  if (date > today) {
    throw new ActionError('The date can’t be after today.', { field: 'date' });
  }
  if (timeIn.getTime() > at.getTime()) {
    throw new ActionError('The time in can’t be in the future.', { field: 'timeIn' });
  }
  if (timeOut && timeOut.getTime() > at.getTime()) {
    throw new ActionError('The time out can’t be in the future.', { field: 'timeOut' });
  }
  if (date < identity.dateHired) {
    throw new ActionError('The date can’t be before your date hired.', { field: 'date' });
  }
  if (identity.separationDate && date > identity.separationDate) {
    throw new ActionError('The date can’t be after your separation date.', { field: 'date' });
  }

  const employeeId = new Types.ObjectId(identity.employeeId);
  const payrollVersions = await loadPayrollVersions({ session });
  await touchTimesheets(
    employeeId,
    [addDays(date, -1), date, addDays(date, 1)],
    payrollVersions,
    current.id,
    session,
  );

  if (!timeOut) {
    const open = await TimeEntryModel.findOne(
      { employeeId, timeOut: null, ...(excludeId ? { _id: { $ne: excludeId } } : {}) },
      { _id: 1 },
    )
      .session(session)
      .lean();
    if (open) throw new ActionError(ALREADY_TIMED_IN);
  }
  // An open entry runs on with no end; a closed one from its time in to its time out. Compared in
  // whole minutes, as the hours are computed (seconds dropped on both ends): an entry clocked out
  // at 17:00:42 and one typed from 17:00 touch, they don't overlap.
  const startsAfter = new Date((epochMinuteOf(timeIn) + 1) * MS_PER_MINUTE);
  const overlap = await TimeEntryModel.findOne(
    {
      employeeId,
      ...(excludeId ? { _id: { $ne: excludeId } } : {}),
      ...(timeOut ? { timeIn: { $lt: new Date(epochMinuteOf(timeOut) * MS_PER_MINUTE) } } : {}),
      $or: [{ timeOut: null }, { timeOut: { $gte: startsAfter } }],
    },
    { date: 1, timeOut: 1 },
  )
    .session(session)
    .lean<Pick<TimeEntryDocument, '_id' | 'date' | 'timeOut'>>();
  if (overlap) {
    throw new ActionError(
      overlap.timeOut === null
        ? 'This entry overlaps your open entry. Time out first, or change its times.'
        : `This entry overlaps another entry on ${formatDate(overlap.date)}.`,
      { field: 'timeIn' },
    );
  }

  const { timesheet } = await ensureTimesheet(identity, date, {
    session,
    payrollVersions,
    actorId: current.id,
  });
  if (timesheet.status !== 'open') throw new ActionError(TIMESHEET_NOT_OPEN);
  return { timesheet, date };
}

/** Refuses a client that isn't a live Core client (unless it is the one already stored). */
async function checkClient(
  clientId: string | null,
  stored: Types.ObjectId | null = null,
): Promise<Types.ObjectId | null> {
  if (!clientId) return null;
  if (stored && stored.toHexString() === clientId) return stored;
  const options = await listClientOptions();
  if (!options.some((option) => option.id === clientId)) {
    throw new ActionError('Choose a client from the list.', { field: 'clientId' });
  }
  return new Types.ObjectId(clientId);
}

async function auditEntry(
  current: OwnContext['current'],
  action: 'create' | 'update' | 'delete',
  entryId: Types.ObjectId,
  label: string,
  before: Record<string, unknown> | null,
  after: Record<string, unknown> | null,
  session: ClientSession,
): Promise<void> {
  await recordAudit(
    {
      actorId: current.id,
      actorEmail: current.email,
      module: 'talent',
      action,
      record: { type: TIME_ENTRY_TYPE, id: entryId, label },
      before,
      after,
    },
    { session },
  );
}

async function findOwnEntry(
  identity: EmployeeIdentity,
  entryId: string,
  session: ClientSession,
): Promise<TimeEntryDocument> {
  const entry = await TimeEntryModel.findOne({
    _id: new Types.ObjectId(entryId),
    employeeId: new Types.ObjectId(identity.employeeId),
  })
    .session(session)
    .lean<TimeEntryDocument>();
  if (!entry) throw new ActionError(ENTRY_NOT_FOUND);
  return entry;
}

/** A time from the sheet: unchanged (the same minute) keeps the stored instant and source. */
function resolveTime(
  sent: Date,
  stored: Date | null,
  storedSource: TimeEntrySource | null,
): { at: Date; source: TimeEntrySource } {
  if (stored && storedSource && epochMinuteOf(stored) === epochMinuteOf(sent)) {
    return { at: stored, source: storedSource };
  }
  return { at: sent, source: 'manual' };
}

// ---------------------------------------------------------------------------------------------
// The clock

/**
 * Time in: a new open entry at the server's time, with the source `clock`. Refused while the
 * employee has an open entry, and on a day the entry rules refuse.
 */
export async function timeIn(actor: TalentActor): Promise<TimeInResult> {
  assertHasEmployee(actor);
  await connectDb();
  return withTransaction(async (session) => {
    const context = await ownContext(actor, session);
    const at = now();
    const { timesheet, date } = await checkEntry(
      context,
      { timeIn: at, timeOut: null },
      { session },
    );
    const entry = new TimeEntryModel({
      employeeId: new Types.ObjectId(context.identity.employeeId),
      timesheetId: timesheet._id,
      date: instantOf(date),
      timeIn: at,
      timeOut: null,
      timeInSource: 'clock',
      timeOutSource: null,
      activity: null,
      clientId: null,
      extraHours: null,
      version: 1,
      createdBy: context.current.id,
      updatedBy: context.current.id,
    });
    await entry.save({ session });
    await auditEntry(
      context.current,
      'create',
      entry._id,
      entryLabel(context.identity.employeeNumber, date),
      null,
      snapshotForAudit(TimeEntryModel, entry),
      session,
    );
    return { entryId: entry._id.toHexString(), timeIn: at, version: 1 };
  });
}

/**
 * Time out: closes the open entry at the server's time, with the source `clock`. When the entry
 * has no activity and none is sent, nothing changes and `activityRequired` comes back: the page
 * asks for it and calls again. The sent activity, client and extra-hours mark are saved with it.
 */
export async function timeOut(
  actor: TalentActor,
  input: TimeOutInput = {},
): Promise<TimeOutResult> {
  assertHasEmployee(actor);
  const parsed = timeOutSchema.safeParse(input);
  if (!parsed.success) throw inputError(parsed.error.issues);
  const values = parsed.data;
  await connectDb();
  return withTransaction(async (session): Promise<TimeOutResult> => {
    const context = await ownContext(actor, session);
    const open = await TimeEntryModel.findOne({
      employeeId: new Types.ObjectId(context.identity.employeeId),
      timeOut: null,
    })
      .session(session)
      .lean<TimeEntryDocument>();
    if (!open) throw new ActionError(NOT_TIMED_IN);

    const activity = values.activity !== undefined ? values.activity : open.activity;
    if (!activity) {
      return { status: 'activityRequired', entryId: open._id.toHexString(), version: open.version };
    }
    const at = now();
    const { timesheet, date } = await checkEntry(
      context,
      { timeIn: open.timeIn, timeOut: at },
      { excludeId: open._id, session },
    );
    const clientId =
      values.clientId !== undefined
        ? await checkClient(values.clientId, open.clientId)
        : open.clientId;
    const extraHours =
      values.extraHoursReason !== undefined
        ? values.extraHoursReason
          ? { reason: values.extraHoursReason }
          : null
        : open.extraHours;

    const updated = await TimeEntryModel.findOneAndUpdate(
      { _id: open._id, version: open.version },
      {
        $set: {
          timesheetId: timesheet._id,
          date: instantOf(date),
          timeOut: at,
          timeOutSource: 'clock',
          activity,
          clientId,
          extraHours,
          updatedBy: new Types.ObjectId(context.current.id),
        },
        $inc: { version: 1 },
      },
      { session, returnDocument: 'after', runValidators: true },
    ).lean<TimeEntryDocument>();
    if (!updated) throw new ActionError(STALE_ENTRY_MESSAGE);
    const { before, after } = snapshotsForAudit(TimeEntryModel, open, updated);
    await auditEntry(
      context.current,
      'update',
      open._id,
      entryLabel(context.identity.employeeNumber, date),
      before,
      after,
      session,
    );
    return {
      status: 'timedOut',
      entryId: open._id.toHexString(),
      timeOut: at,
      version: updated.version,
    };
  });
}

// ---------------------------------------------------------------------------------------------
// Manual entries

function sheetTimes(values: {
  date: BusinessDate;
  timeIn: string;
  timeOut: string | null;
  timeOutNextDay: boolean;
}): EntryTimes {
  return {
    timeIn: instantAt(values.date, values.timeIn),
    timeOut: values.timeOut
      ? instantAt(values.timeOutNextDay ? addDays(values.date, 1) : values.date, values.timeOut)
      : null,
  };
}

/**
 * "Add entry": an entry with typed (`manual`) times on the employee's own timesheet. With no time
 * out it becomes the open entry (one at most). Every entry rule applies.
 */
export async function createTimeEntry(
  actor: TalentActor,
  input: CreateTimeEntryInput,
): Promise<{ id: string; version: number }> {
  assertHasEmployee(actor);
  const parsed = createTimeEntrySchema.safeParse(input);
  if (!parsed.success) throw inputError(parsed.error.issues);
  const values = parsed.data;
  const times = sheetTimes(values);
  if (times.timeOut && !values.activity) {
    throw new ActionError(ACTIVITY_REQUIRED, { field: 'activity' });
  }
  await connectDb();
  return withTransaction(async (session) => {
    const context = await ownContext(actor, session);
    const { timesheet, date } = await checkEntry(context, times, { session });
    const clientId = await checkClient(values.clientId);
    const entry = new TimeEntryModel({
      employeeId: new Types.ObjectId(context.identity.employeeId),
      timesheetId: timesheet._id,
      date: instantOf(date),
      timeIn: times.timeIn,
      timeOut: times.timeOut,
      timeInSource: 'manual',
      timeOutSource: times.timeOut ? 'manual' : null,
      activity: values.activity,
      clientId,
      extraHours: values.extraHoursReason ? { reason: values.extraHoursReason } : null,
      version: 1,
      createdBy: context.current.id,
      updatedBy: context.current.id,
    });
    await entry.save({ session });
    await auditEntry(
      context.current,
      'create',
      entry._id,
      entryLabel(context.identity.employeeNumber, date),
      null,
      snapshotForAudit(TimeEntryModel, entry),
      session,
    );
    return { id: entry._id.toHexString(), version: 1 };
  });
}

/**
 * The edit sheet: saves the whole entry against its `version`. A time sent unchanged (the same
 * minute) keeps its stored instant and source; a typed or changed one becomes `manual`. A closed
 * entry can't be reopened. Only the employee's own entries: anyone else's is not found.
 */
export async function updateTimeEntry(
  actor: TalentActor,
  input: UpdateTimeEntryInput,
): Promise<{ id: string; version: number }> {
  assertHasEmployee(actor);
  const parsed = updateTimeEntrySchema.safeParse(input);
  if (!parsed.success) throw inputError(parsed.error.issues);
  const values = parsed.data;
  const sent = sheetTimes(values);
  if (sent.timeOut && !values.activity) {
    throw new ActionError(ACTIVITY_REQUIRED, { field: 'activity' });
  }
  await connectDb();
  return withTransaction(async (session) => {
    const context = await ownContext(actor, session);
    const existing = await findOwnEntry(context.identity, values.entryId, session);
    if (existing.version !== values.version) throw new ActionError(STALE_ENTRY_MESSAGE);
    if (!sent.timeOut && existing.timeOut) {
      throw new ActionError('Enter the time out.', { field: 'timeOut' });
    }
    const timeInValue = resolveTime(sent.timeIn, existing.timeIn, existing.timeInSource);
    const timeOutValue = sent.timeOut
      ? resolveTime(sent.timeOut, existing.timeOut, existing.timeOutSource)
      : null;

    const { timesheet, date } = await checkEntry(
      context,
      { timeIn: timeInValue.at, timeOut: timeOutValue?.at ?? null },
      { excludeId: existing._id, session },
    );
    const clientId = await checkClient(values.clientId, existing.clientId);

    const updated = await TimeEntryModel.findOneAndUpdate(
      { _id: existing._id, version: existing.version },
      {
        $set: {
          timesheetId: timesheet._id,
          date: instantOf(date),
          timeIn: timeInValue.at,
          timeInSource: timeInValue.source,
          timeOut: timeOutValue?.at ?? null,
          timeOutSource: timeOutValue?.source ?? null,
          activity: values.activity,
          clientId,
          extraHours: values.extraHoursReason ? { reason: values.extraHoursReason } : null,
          updatedBy: new Types.ObjectId(context.current.id),
        },
        $inc: { version: 1 },
      },
      { session, returnDocument: 'after', runValidators: true },
    ).lean<TimeEntryDocument>();
    if (!updated) throw new ActionError(STALE_ENTRY_MESSAGE);
    const { before, after } = snapshotsForAudit(TimeEntryModel, existing, updated);
    await auditEntry(
      context.current,
      'update',
      existing._id,
      entryLabel(context.identity.employeeNumber, date),
      before,
      after,
      session,
    );
    return { id: existing._id.toHexString(), version: updated.version };
  });
}

/** "Delete entry": a soft delete (`deletedAt`) against the entry's `version`, own entries only. */
export async function deleteTimeEntry(
  actor: TalentActor,
  input: DeleteTimeEntryInput,
): Promise<void> {
  assertHasEmployee(actor);
  const parsed = deleteTimeEntrySchema.safeParse(input);
  if (!parsed.success) throw inputError(parsed.error.issues);
  const values = parsed.data;
  await connectDb();
  await withTransaction(async (session) => {
    const context = await ownContext(actor, session);
    const existing = await findOwnEntry(context.identity, values.entryId, session);
    if (existing.version !== values.version) throw new ActionError(STALE_ENTRY_MESSAGE);
    const timesheet = await TimesheetModel.findById(existing.timesheetId, { status: 1 })
      .session(session)
      .lean();
    if (timesheet && timesheet.status !== 'open') throw new ActionError(TIMESHEET_NOT_OPEN);
    const date = dayOf(existing.date);
    await touchTimesheets(
      existing.employeeId,
      [date],
      await loadPayrollVersions({ session }),
      context.current.id,
      session,
    );
    const deleted = await TimeEntryModel.findOneAndUpdate(
      { _id: existing._id, version: existing.version },
      {
        $set: { deletedAt: now(), updatedBy: new Types.ObjectId(context.current.id) },
        $inc: { version: 1 },
      },
      { session, returnDocument: 'after' },
    ).lean<TimeEntryDocument>();
    if (!deleted) throw new ActionError(STALE_ENTRY_MESSAGE);
    await auditEntry(
      context.current,
      'delete',
      existing._id,
      entryLabel(context.identity.employeeNumber, date),
      snapshotForAudit(TimeEntryModel, existing),
      null,
      session,
    );
  });
}

// ---------------------------------------------------------------------------------------------
// The reads

export interface TimesheetViewOptions {
  /** A cut-off's period start (`?cutOff=YYYY-MM-DD`); today's cut-off when absent. */
  cutOff?: string | null;
}

/** The team list's link for each active direct report (directory fields only). */
function teamLinks(identities: EmployeeIdentity[]): TeamMemberLink[] {
  return identities.map((identity) => {
    const directory = toDirectoryIdentity(identity);
    return {
      employeeId: directory.employeeId,
      name: nameOf(directory),
      employeeNumber: directory.employeeNumber,
      href: `/talent/timesheets/${directory.employeeId}`,
    };
  });
}

/** "My team": the actor's active direct reports, each linking to their timesheet. */
export async function listMyTeam(actor: TalentActor): Promise<TeamMemberLink[]> {
  if (!actor.employee) return [];
  await connectDb();
  return teamLinks(await listDirectReportIdentities(actor));
}

function recordView(timesheet: TimesheetDocument): TimesheetRecordView {
  return {
    id: timesheet._id.toHexString(),
    employeeId: timesheet.employeeId.toHexString(),
    periodStart: dayOf(timesheet.periodStart),
    periodEnd: dayOf(timesheet.periodEnd),
    payDate: dayOf(timesheet.payDate),
    cutOffKey: timesheet.cutOffKey,
    timesheetType: timesheet.timesheetType,
    typeReadOn: dayOf(timesheet.typeReadOn),
    status: timesheet.status,
  };
}

interface ViewTarget {
  identity: EmployeeIdentity;
  /** The signed-in user, on their own timesheet: the clock, the client options and My team. */
  owner: TalentActor | null;
}

/**
 * Builds a timesheet view. Null when the cut-off is out of range: not a cut-off's start, ending
 * before the date hired, or after today's cut-off. The employee's own timesheet is created on
 * first use; another person's that isn't created yet shows with `id` null and no entries.
 */
async function buildView(
  { identity, owner }: ViewTarget,
  options: TimesheetViewOptions,
): Promise<TimesheetView | null> {
  const own = owner !== null;
  const today = businessToday();
  const payrollVersions = await loadPayrollVersions();
  const todayPeriod = periodOrNull(today, payrollVersions);
  if (!todayPeriod) return null;

  let period = todayPeriod;
  if (options.cutOff) {
    if (!isBusinessDate(options.cutOff)) return null;
    const asked = periodOrNull(options.cutOff, payrollVersions);
    if (!asked || asked.start !== options.cutOff) return null;
    period = asked;
  }
  if (period.end < identity.dateHired || period.start > todayPeriod.start) return null;

  const employeeId = new Types.ObjectId(identity.employeeId);
  let timesheet: TimesheetRecordView;
  if (own) {
    timesheet = recordView(
      (await ensureTimesheet(identity, period.start, { payrollVersions })).timesheet,
    );
  } else {
    const stored = await TimesheetModel.findOne({
      employeeId,
      periodStart: instantOf(period.start),
    }).lean<TimesheetDocument>();
    if (stored) {
      timesheet = recordView(stored);
    } else {
      if (!identity.position) throw new ActionError(OTHER_POSITION_MISSING);
      timesheet = {
        id: null,
        employeeId: identity.employeeId,
        periodStart: period.start,
        periodEnd: period.end,
        payDate: period.payDate,
        cutOffKey: period.key,
        timesheetType: identity.position.timesheetType,
        typeReadOn: today,
        status: 'open',
      };
    }
  }

  const from = identity.dateHired > period.start ? identity.dateHired : period.start;
  let to = today < period.end ? today : period.end;
  if (identity.separationDate && identity.separationDate < to) to = identity.separationDate;

  const [
    entries,
    openEntry,
    holidays,
    workSchedules,
    assignments,
    premiumRates,
    settings,
    clients,
  ] = await Promise.all([
    timesheet.id
      ? TimeEntryModel.find({
          employeeId,
          date: { $gte: instantOf(period.start), $lte: instantOf(period.end) },
        })
          .sort({ timeIn: 1, _id: 1 })
          .lean<TimeEntryDocument[]>()
      : Promise.resolve([] as TimeEntryDocument[]),
    TimeEntryModel.findOne({ employeeId, timeOut: null }).lean<TimeEntryDocument>(),
    listConfirmedHolidays({ from: period.start, to: period.end }),
    listCompanyScheduleVersions(),
    loadWorkScheduleAssignments(identity.employeeId),
    listConfigVersions(PREMIUM_RATES_SETTING),
    listConfigVersions(TIMESHEET_SETTINGS_SETTING),
    listClientOptions(),
  ]);

  const hours = computeTimesheet({
    timesheetType: timesheet.timesheetType,
    periodStart: period.start,
    periodEnd: period.end,
    from,
    to,
    entries: entries.map((entry) => ({
      id: entry._id.toHexString(),
      timeIn: entry.timeIn,
      timeOut: entry.timeOut,
      extraHours: entry.extraHours ? { reason: entry.extraHours.reason } : null,
    })),
    holidays,
    workSchedules,
    assignments,
    premiumRates,
    timesheetSettings: settings,
    payrollSettings: payrollVersions,
  });

  const clientNames = new Map(clients.map((client) => [client.id, client.name]));
  const entriesByDay = new Map<BusinessDate, TimeEntryDocument[]>();
  for (const entry of entries) {
    const date = manilaDateOf(entry.timeIn);
    const list = entriesByDay.get(date);
    if (list) list.push(entry);
    else entriesByDay.set(date, [entry]);
  }

  const days: TimesheetDayView[] = hours.days.map((day: TimesheetDayHours) => {
    // The day's hours without its per-entry hours (on each entry) and its schedule.
    const dayHours: Partial<Pick<TimesheetDayHours, 'entries' | 'schedule'>> &
      Omit<TimesheetDayHours, 'entries' | 'schedule'> = { ...day };
    delete dayHours.entries;
    delete dayHours.schedule;
    const hoursById = new Map(day.entries.map((entry) => [entry.id, entry]));
    return {
      hours: dayHours,
      kindLabel: dayKindLabel(day),
      entries: (entriesByDay.get(day.date) ?? []).flatMap((entry): TimeEntryView[] => {
        const id = entry._id.toHexString();
        const entryHoursOf = hoursById.get(id);
        if (!entryHoursOf) return [];
        const clientId = entry.clientId?.toHexString() ?? null;
        return [
          {
            id,
            date: day.date,
            timeIn: entry.timeIn,
            timeOut: entry.timeOut,
            timeInSource: entry.timeInSource,
            timeOutSource: entry.timeOutSource,
            activity: entry.activity,
            client: clientId
              ? { id: clientId, name: clientNames.get(clientId) ?? 'Removed client' }
              : null,
            extraHours: entry.extraHours ? { reason: entry.extraHours.reason } : null,
            endsNextDay: entry.timeOut !== null && manilaDateOf(entry.timeOut) > day.date,
            version: entry.version,
            hours: entryHoursOf,
          },
        ];
      }),
    };
  });

  const onTodaysCutOff = period.start === todayPeriod.start && today >= from && today <= to;
  const todayHours = onTodaysCutOff ? hours.days.find((day) => day.date === today) : undefined;
  const todayCard: TimesheetTodayView | null = todayHours
    ? {
        date: today,
        workedMinutes: todayHours.workedMinutes,
        scheduledMinutes: scheduledMinutes(todayHours.schedule.schedule),
        workDay: todayHours.kind === 'ordinary',
        openEntry: openEntry
          ? {
              id: openEntry._id.toHexString(),
              timeIn: openEntry.timeIn,
              hasActivity: Boolean(openEntry.activity),
              version: openEntry.version,
            }
          : null,
      }
    : null;

  const previousEnd = addDays(period.start, -1);
  const previous =
    previousEnd >= identity.dateHired ? periodOrNull(previousEnd, payrollVersions) : null;
  const nextStart = addDays(period.end, 1);
  const next = nextStart <= todayPeriod.start ? periodOrNull(nextStart, payrollVersions) : null;
  const scheduleDay = from <= to ? to : period.start;

  const directory = toDirectoryIdentity(identity);
  const view: TimesheetView = {
    today,
    timesheet,
    employee: {
      id: directory.employeeId,
      name: nameOf(directory),
      employeeNumber: directory.employeeNumber,
    },
    own,
    treatment: hours.treatment,
    hoursPerDay: hours.hoursPerDay,
    days,
    totals: hours.totals,
    todayCard,
    offset:
      hours.treatment === 'offset'
        ? { balanceMinutes: 0, thisCutOffMinutes: hours.totals.offsetMinutes }
        : null,
    previousCutOff: previous?.start ?? null,
    nextCutOff: next?.start ?? null,
    schedule: scheduleOn(scheduleDay, workSchedules, assignments),
    reimbursements: await reimbursementsSectionFor(identity, timesheet, {
      own,
      today,
      payrollVersions,
    }),
  };
  if (owner) {
    view.clients = clients.map((client) => ({ id: client.id, name: client.name }));
    const team = teamLinks(await listDirectReportIdentities(owner));
    if (team.length > 0) view.myTeam = team;
  }
  return view;
}

/**
 * `/talent/timesheet`: the signed-in user's own timesheet for a cut-off (`cutOff`, a period
 * start; today's by default), with the clock, the client options and "My team". Self-service:
 * no employee id is taken. Null when the cut-off is out of range. The system account is refused.
 */
export async function getOwnTimesheetView(
  actor: TalentActor,
  options: TimesheetViewOptions = {},
): Promise<TimesheetView | null> {
  const ownEmployee = actor.employee;
  if (!ownEmployee) throw new AccessDeniedError(NO_EMPLOYEE_TIMESHEET);
  await connectDb();
  const identity = await getEmployeeIdentity(actor, ownEmployee.id, { separated: true });
  if (!identity) throw new ActionError(EMPLOYEE_GONE);
  return buildView({ identity, owner: actor }, options);
}

/**
 * `/talent/timesheets/<employeeId>`: another employee's timesheet, read-only, for Talent Read or
 * one of the employee's `reportingTo` supervisors (whatever their module access); anyone else
 * gets {@link AccessDeniedError}. Null when there is no such employee or the cut-off is out of
 * range. The view carries directory fields only about the employee: never the date hired or the
 * employment status. Nothing here changes an entry.
 */
export async function getTimesheetView(
  actor: TalentActor,
  employeeId: string,
  options: TimesheetViewOptions = {},
): Promise<TimesheetView | null> {
  await connectDb();
  const identity = await getEmployeeIdentity(actor, employeeId, { separated: true });
  if (!identity) return null;
  assertCanViewTimesheet(actor, identity);
  return buildView({ identity, owner: null }, options);
}
