import { type ClientSession, Types } from 'mongoose';
import { connectDb } from '@pulse/db';
import { ActionError, type BusinessDate } from '@pulse/core';
import type { EmployeeIdentity } from '@pulse/core/server';
import type { Sex } from '../../fixed-sets';
import { splitLeaveDays } from '../../time-off/balance';
import {
  halfDaysByYear,
  type TimeOffCoverageDay,
  type TimeOffDayContext,
  type TimeOffRequestDay,
  timeOffRequestDays,
} from '../../time-off/days';
import {
  leaveAttachmentProblems,
  leaveEligibilityProblems,
  leaveFilingWindowProblems,
  leaveLimitProblems,
  offsetTimeOffProblems,
  type TimeOffProblem,
  timeOffOverlapProblems,
  timeOffProblemHref,
  timeOffProblemMessage,
  timeOffSpanProblems,
  workedLeaveProblems,
} from '../../time-off/rules';
import type { TimeOffRequestInput } from '../../time-off/schemas';
import { type LeaveSettings, type LeaveType, leaveTypeOf } from '../../time-off/settings';
import { loadTimeEntries } from '../dtr/service';
import { EmployeeRecordModel } from '../employee-records/model';
import { availableLeaveHalfDaysOf } from '../leave/service';
import { availableOffsetMinutesOf } from '../offset/service';
import { dayOf, instantOf } from '../shared';
import { loadTimesheetSettings, deadlineOf } from '../timesheets/status';
import { loadPayrollVersions, periodOrNull } from '../timesheets/periods';
import { loadTimeOffContext, spanOf, storedRequestDays, typeOfRequest } from './days';
import { type TimeOffRequestDocument, TimeOffRequestModel } from './model';

// Spec: docs/modules/talent.md#leave-offset-time-off-and-opening-balances-build-step-28 ("Filing
// a leave request", "Insufficient balance", "Filing offset time off", "Approval"; decisions
// 310–312 in docs/BUILD_PLAN.md) — the facts a request is checked against, gathered from the
// database (in the caller's transaction when given one), and the pure rules of chunk A
// (`time-off/rules.ts`) applied in the spec's order. The service throws the first problem; the
// request sheet's preview shows them all, in the same words.

export const LEAVE_TYPE_UNKNOWN = 'Choose the leave type.';
export const OFFSET_NO_ATTACHMENT = 'Offset time off takes no attachment.';
export const LEAVE_TYPE_NO_ATTACHMENT = 'This leave type takes no attachment.';

/** What a request is checked against. */
export interface TimeOffCheckContext {
  identity: EmployeeIdentity;
  settings: LeaveSettings;
  today: BusinessDate;
  /** The moment of filing or sending again (offset time off must start after it). */
  at: Date;
  session: ClientSession | null;
  /** The request being sent again, left out of every holding and the overlap. */
  exceptRequestId: Types.ObjectId | null;
}

/** A checked request: its days, charge and split, and every problem found, in order. */
export interface CheckedTimeOff {
  type: LeaveType | null;
  days: TimeOffRequestDay[];
  chargeableHalfDays: number | null;
  paidHalfDays: number | null;
  unpaidHalfDays: number | null;
  minutes: number | null;
  problems: TimeOffProblem[];
}

/** The form field a problem shows next to. */
export function problemField(problem: TimeOffProblem): string | undefined {
  switch (problem.kind) {
    case 'typeInactive':
    case 'status':
    case 'sexMissing':
    case 'sex':
    case 'serviceMonths':
    case 'maxRequests':
      return 'leaveTypeKey';
    case 'endBeforeStart':
    case 'tooLong':
      return 'endDate';
    case 'portion':
      return 'portion';
    case 'partOutsideSchedule':
    case 'offsetStep':
      return 'fromTime';
    case 'attachment':
      return 'attachment';
    default:
      return 'startDate';
  }
}

/**
 * A refused request: the problem's words next to its field, with the problem itself and the link
 * it offers (My record for a missing sex) for the request sheet.
 */
export class TimeOffRefusedError extends ActionError {
  readonly problem: TimeOffProblem;
  readonly href: string | null;
  constructor(problem: TimeOffProblem) {
    super(timeOffProblemMessage(problem), { field: problemField(problem) });
    this.name = 'TimeOffRefusedError';
    this.problem = problem;
    this.href = timeOffProblemHref(problem);
  }
}

/** The employee's pending and approved requests that may touch `from` to `to` (or their years). */
async function holdingRequests(
  employeeId: string,
  { from, to }: { from: BusinessDate; to: BusinessDate },
  { session, exceptRequestId }: Pick<TimeOffCheckContext, 'session' | 'exceptRequestId'>,
): Promise<TimeOffRequestDocument[]> {
  return TimeOffRequestModel.find({
    employeeId: new Types.ObjectId(employeeId),
    status: { $in: ['pending', 'approved'] },
    startDate: { $lte: instantOf(to) },
    endDate: { $gte: instantOf(from) },
    ...(exceptRequestId ? { _id: { $ne: exceptRequestId } } : {}),
  })
    .session(session)
    .lean<TimeOffRequestDocument[]>();
}

/** Another request's days as the overlap check reads them. */
function coverageOf(
  request: TimeOffRequestDocument,
  settings: LeaveSettings,
  context: TimeOffDayContext,
): TimeOffCoverageDay[] {
  return storedRequestDays(request, typeOfRequest(settings, request), context).map((day) => ({
    date: day.date,
    portion: day.portion,
    intervals: day.intervals,
  }));
}

function minDay(...days: BusinessDate[]): BusinessDate {
  return days.reduce((a, b) => (b < a ? b : a));
}

function maxDay(...days: BusinessDate[]): BusinessDate {
  return days.reduce((a, b) => (b > a ? b : a));
}

/** The employee record's sex, or null. */
async function sexOf(employeeId: string, session: ClientSession | null): Promise<Sex | null> {
  const record = await EmployeeRecordModel.findOne(
    { employeeId: new Types.ObjectId(employeeId) },
    { sex: 1 },
  )
    .session(session)
    .lean<{ sex?: Sex | null } | null>();
  return record?.sex ?? null;
}

/** The deadline of the cut-off holding `startDate`, or null when no pay schedule covers it. */
async function firstDayDeadline(
  startDate: BusinessDate,
  session: ClientSession | null,
): Promise<BusinessDate | null> {
  const options = session ? { session } : {};
  const [payrollVersions, timesheetSettings] = await Promise.all([
    loadPayrollVersions(options),
    loadTimesheetSettings(session),
  ]);
  const period = periodOrNull(startDate, payrollVersions);
  return period ? deadlineOf(period.end, timesheetSettings) : null;
}

/**
 * Checks a request against everything filing checks besides the gate and the account (the
 * service's own), in the spec's order, and works out its days, charge and split. Throws only for
 * a leave type that doesn't exist; every other refusal is in `problems`.
 */
export async function checkTimeOffRequest(
  context: TimeOffCheckContext,
  input: TimeOffRequestInput,
  { hasAttachment }: { hasAttachment: boolean },
): Promise<CheckedTimeOff> {
  await connectDb();
  const { identity, settings, today, session } = context;
  const employeeId = identity.employeeId;
  const problems: TimeOffProblem[] = [];
  const type = input.kind === 'leave' ? leaveTypeOf(settings, input.leaveTypeKey) : null;
  if (input.kind === 'leave' && !type) {
    throw new ActionError(LEAVE_TYPE_UNKNOWN, { field: 'leaveTypeKey' });
  }

  if (type) {
    const [sex, approvedRequestCount] = await Promise.all([
      sexOf(employeeId, session),
      TimeOffRequestModel.countDocuments({
        employeeId: new Types.ObjectId(employeeId),
        kind: 'leave',
        leaveTypeKey: type.key,
        status: 'approved',
        ...(context.exceptRequestId ? { _id: { $ne: context.exceptRequestId } } : {}),
      }).session(session),
    ]);
    problems.push(
      ...leaveEligibilityProblems({
        type,
        employmentStatus: identity.employmentStatus,
        sex,
        dateHired: identity.dateHired,
        today,
        approvedRequestCount,
        allTypes: settings.types,
      }),
    );
  }

  const spanProblems = timeOffSpanProblems({
    kind: input.kind,
    startDate: input.startDate,
    endDate: input.endDate,
    portion: input.portion,
    halfDaysAllowed: type?.halfDays ?? false,
  });
  problems.push(...spanProblems);
  const empty: CheckedTimeOff = {
    type,
    days: [],
    chargeableHalfDays: null,
    paidHalfDays: null,
    unpaidHalfDays: null,
    minutes: null,
    problems,
  };
  // Without a valid range the days can't be counted.
  if (spanProblems.some((problem) => problem.kind !== 'portion')) return empty;

  if (type) {
    problems.push(
      ...leaveFilingWindowProblems({
        type,
        startDate: input.startDate,
        endDate: input.endDate,
        today,
        firstDayDeadline:
          input.startDate < today ? await firstDayDeadline(input.startDate, session) : null,
      }),
    );
  }

  // Other requests: those overlapping the range, and for a `perYear` type the whole years.
  const yearsFrom = type?.balance === 'perYear' ? `${input.startDate.slice(0, 4)}-01-01` : null;
  const yearsTo = type?.balance === 'perYear' ? `${input.endDate.slice(0, 4)}-12-31` : null;
  const others = await holdingRequests(
    employeeId,
    { from: yearsFrom ?? input.startDate, to: yearsTo ?? input.endDate },
    context,
  );
  const dayContext = await loadTimeOffContext(
    employeeId,
    identity,
    {
      from: minDay(input.startDate, ...others.map((other) => dayOf(other.startDate))),
      to: maxDay(input.endDate, ...others.map((other) => dayOf(other.endDate))),
    },
    session,
  );
  const span = {
    startDate: input.startDate,
    endDate: input.endDate,
    portion: input.portion,
    fromTime: input.kind === 'offset' ? input.fromTime : null,
    toTime: input.kind === 'offset' ? input.toTime : null,
  };
  const overlapping = others.filter(
    (other) => dayOf(other.startDate) <= input.endDate && dayOf(other.endDate) >= input.startDate,
  );
  const otherCoverage = overlapping.flatMap((other) => coverageOf(other, settings, dayContext));

  if (input.kind === 'offset') {
    const days = timeOffRequestDays(span, 'workDays', dayContext);
    const availableMinutes = await availableOffsetMinutesOf(employeeId, {
      exceptRequestId: context.exceptRequestId,
      session,
    });
    problems.push(
      ...offsetTimeOffProblems({
        settings,
        portion: input.portion,
        days,
        fromTime: input.fromTime,
        filedAt: context.at,
        availableMinutes,
      }),
      ...timeOffOverlapProblems(days, otherCoverage),
    );
    const minutes = days.reduce((total, day) => total + (day.chargeable ? day.minutes : 0), 0);
    return { ...empty, days, minutes };
  }

  const leaveType = type as LeaveType;
  const rawDays = timeOffRequestDays(span, leaveType.countDays, dayContext);
  const sameType = others.filter(
    (other) => other.kind === 'leave' && other.leaveTypeKey === leaveType.key,
  );
  const otherHalfDaysByYear = new Map<number, number>();
  if (leaveType.balance === 'perYear') {
    for (const other of sameType) {
      // Each day's own year (HANDOFF item 185): a request across December 31 counts in both.
      const byYear = halfDaysByYear(storedRequestDays(other, leaveType, dayContext));
      for (const [year, halfDays] of byYear) {
        otherHalfDaysByYear.set(year, (otherHalfDaysByYear.get(year) ?? 0) + halfDays);
      }
    }
  }
  problems.push(...leaveLimitProblems({ type: leaveType, days: rawDays, otherHalfDaysByYear }));
  problems.push(...timeOffOverlapProblems(rawDays, otherCoverage));
  const entries = await loadTimeEntries(
    employeeId,
    { from: input.startDate, to: input.endDate },
    session,
  );
  problems.push(
    ...workedLeaveProblems(
      rawDays,
      entries.map((entry) => ({ timeIn: entry.timeIn, timeOut: entry.timeOut })),
    ),
  );
  problems.push(...leaveAttachmentProblems(leaveType, hasAttachment));

  const available =
    leaveType.balance === 'credited'
      ? await availableLeaveHalfDaysOf(employeeId, leaveType.key, {
          today,
          exceptRequestId: context.exceptRequestId,
          session,
        })
      : 0;
  const { days, split } = splitLeaveDays(rawDays, leaveType, available);
  return {
    ...empty,
    days,
    chargeableHalfDays: split.chargeableHalfDays,
    paidHalfDays: split.paidHalfDays,
    unpaidHalfDays: split.unpaidHalfDays,
  };
}

/** A request's days and charge as they count now (the approval's re-check and the listener). */
export async function recountStoredRequest(
  request: TimeOffRequestDocument,
  identity: EmployeeIdentity,
  settings: LeaveSettings,
  session: ClientSession | null,
): Promise<{ type: LeaveType | null; days: TimeOffRequestDay[]; context: TimeOffDayContext }> {
  const span = spanOf(request);
  const context = await loadTimeOffContext(
    identity.employeeId,
    identity,
    { from: span.startDate, to: span.endDate },
    session,
  );
  const type = typeOfRequest(settings, request);
  const days =
    request.kind === 'offset'
      ? timeOffRequestDays(span, 'workDays', context)
      : timeOffRequestDays(span, type?.countDays ?? 'workDays', context);
  return { type, days, context };
}

/** The first day `request` overlaps one of the employee's other **approved** requests, or null. */
export async function approvedOverlapOf(
  request: TimeOffRequestDocument,
  days: readonly TimeOffRequestDay[],
  identity: EmployeeIdentity,
  settings: LeaveSettings,
  session: ClientSession,
): Promise<BusinessDate | null> {
  const span = spanOf(request);
  const approved = (
    await holdingRequests(
      identity.employeeId,
      { from: span.startDate, to: span.endDate },
      { session, exceptRequestId: request._id },
    )
  ).filter((other) => other.status === 'approved');
  if (approved.length === 0) return null;
  const context = await loadTimeOffContext(
    identity.employeeId,
    identity,
    {
      from: minDay(...approved.map((other) => dayOf(other.startDate))),
      to: maxDay(...approved.map((other) => dayOf(other.endDate))),
    },
    session,
  );
  const coverage = approved.flatMap((other) => coverageOf(other, settings, context));
  const [problem] = timeOffOverlapProblems(days, coverage);
  return problem?.kind === 'overlap' ? problem.date : null;
}
