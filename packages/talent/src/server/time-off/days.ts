import { type ClientSession, Types } from 'mongoose';
import { connectDb } from '@pulse/db';
import type { BusinessDate } from '@pulse/core';
import { listConfirmedHolidays } from '@pulse/core/server';
import type { DtrTimeOffInput } from '../../dtr/compute';
import { splitLeaveDays } from '../../time-off/balance';
import {
  type TimeOffDayContext,
  type TimeOffRequestDay,
  type TimeOffSpan,
  timeOffRequestDays,
} from '../../time-off/days';
import { type LeaveSettings, type LeaveType, leaveTypeOf } from '../../time-off/settings';
import { CONFIDENTIAL_LEAVE_LABEL, leaveTypeShortLabel } from '../../time-off/views';
import { leaveSettingsOn } from '../payroll-settings/settings';
import { dayOf, instantOf } from '../shared';
import {
  listCompanyScheduleVersions,
  loadWorkScheduleAssignments,
} from '../work-schedules/service';
import { type TimeOffRequestDocument, TimeOffRequestModel } from './model';

// Spec: docs/modules/talent.md#leave-offset-time-off-and-opening-balances-build-step-28 ("Units
// and counting", "On the DTR"; decisions 302 and 315 in docs/BUILD_PLAN.md) — a stored request's
// days read against the schedules and confirmed holidays as they are now, and the DTR's feed of
// approved time off: chunk A's `TimeOffRequestDay`s mapped to the DTR's `DtrTimeOffInput`s.
//
// Kept apart from the time off service so the DTR service can read the feed without importing the
// service (which itself reads time entries through the DTR service).

/** The employee fields a request's days read. */
export interface TimeOffSubject {
  dateHired: BusinessDate;
  separationDate: BusinessDate | null;
}

/** The schedules and confirmed holidays from `from` to `to`, for `employeeId`'s requests. */
export async function loadTimeOffContext(
  employeeId: string,
  subject: TimeOffSubject,
  { from, to }: { from: BusinessDate; to: BusinessDate },
  session: ClientSession | null = null,
): Promise<TimeOffDayContext> {
  await connectDb();
  const options = session ? { session } : {};
  const [holidays, defaultVersions, assignments] = await Promise.all([
    from <= to ? listConfirmedHolidays({ from, to }, options) : Promise.resolve([]),
    listCompanyScheduleVersions(options),
    loadWorkScheduleAssignments(employeeId, options),
  ]);
  return {
    schedules: { defaultVersions, assignments },
    holidays,
    dateHired: subject.dateHired,
    separationDate: subject.separationDate,
  };
}

/** A stored request's span. */
export function spanOf(
  request: Pick<
    TimeOffRequestDocument,
    'startDate' | 'endDate' | 'portion' | 'fromTime' | 'toTime'
  >,
): TimeOffSpan {
  return {
    startDate: dayOf(request.startDate),
    endDate: dayOf(request.endDate),
    portion: request.portion,
    fromTime: request.fromTime,
    toTime: request.toTime,
  };
}

/** The type of a leave request, from `settings` (a key, once added, stays in every version). */
export function typeOfRequest(
  settings: Pick<LeaveSettings, 'types'>,
  request: Pick<TimeOffRequestDocument, 'kind' | 'leaveTypeKey'>,
): LeaveType | null {
  if (request.kind !== 'leave' || !request.leaveTypeKey) return null;
  return leaveTypeOf(settings, request.leaveTypeKey);
}

/**
 * A stored request's days as they count now: leave under its type's `countDays` (work days when
 * the type is missing), each marked paid or unpaid from its stored split (paid from the first
 * day); offset time off on work days.
 */
export function storedRequestDays(
  request: Pick<
    TimeOffRequestDocument,
    'kind' | 'leaveTypeKey' | 'startDate' | 'endDate' | 'portion' | 'fromTime' | 'toTime'
  > &
    Pick<TimeOffRequestDocument, 'paidHalfDays'>,
  type: LeaveType | null,
  context: TimeOffDayContext,
): TimeOffRequestDay[] {
  const span = spanOf(request);
  if (request.kind === 'offset') return timeOffRequestDays(span, 'workDays', context);
  const days = timeOffRequestDays(span, type?.countDays ?? 'workDays', context);
  const pay = { balance: type?.balance ?? 'perEvent', paid: type?.paid ?? true } as const;
  return splitLeaveDays(days, pay, request.paidHalfDays ?? 0).days;
}

/**
 * One request day as the DTR's inputs: none on a day that doesn't count; leave as one input, or
 * two halves when a whole day is half paid and half unpaid; offset with its covered times.
 */
export function dtrInputsOfDay(
  request: Pick<TimeOffRequestDocument, '_id' | 'kind' | 'portion' | 'fromTime' | 'toTime'>,
  day: TimeOffRequestDay,
  shortName: string,
): DtrTimeOffInput[] {
  if (!day.chargeable) return [];
  const base = { date: day.date, shortName, requestId: request._id.toHexString() };
  if (request.kind === 'offset') {
    return [
      {
        ...base,
        kind: 'offset',
        status: 'offsetPaid',
        portion: request.portion,
        ...(request.portion === 'part' && request.fromTime && request.toTime
          ? { intervals: [{ fromTime: request.fromTime, toTime: request.toTime }] }
          : {}),
      },
    ];
  }
  if (day.halfDays === 0) return [];
  const leave = { ...base, kind: 'leave' as const };
  if (day.unpaidHalfDays === 0) return [{ ...leave, status: 'onLeavePaid', portion: day.portion }];
  if (day.paidHalfDays === 0) {
    return [{ ...leave, status: 'leaveWithoutPay', portion: day.portion }];
  }
  // A whole day half paid: the first half paid, the second without pay (the unpaid days are the
  // last ones).
  return [
    { ...leave, status: 'onLeavePaid', portion: 'firstHalf' },
    { ...leave, status: 'leaveWithoutPay', portion: 'secondHalf' },
  ];
}

/** The short name the DTR shows for a request: the type's, "Leave" when hidden, or "Offset". */
export function dtrShortNameOf(
  request: Pick<TimeOffRequestDocument, 'kind' | 'leaveTypeKey'>,
  type: LeaveType | null,
  canSeeConfidential: boolean,
): string {
  if (request.kind === 'offset') return 'Offset';
  if (!type) return CONFIDENTIAL_LEAVE_LABEL;
  return leaveTypeShortLabel(type, canSeeConfidential);
}

export interface ApprovedTimeOffOptions {
  session?: ClientSession | null;
  /** The viewer sees a confidential type's short name (the employee, HR, the System Administrator). */
  canSeeConfidential?: boolean;
}

/**
 * The DTR's `timeOff` input (decision 315): every **approved** request of `employeeId` covering a
 * day from `from` to `to`, one input per covered day (two for a half-paid whole day), only for
 * the days in the range. A pending request never changes the DTR.
 */
export async function approvedTimeOffInputs(
  employeeId: string,
  subject: TimeOffSubject,
  { from, to }: { from: BusinessDate; to: BusinessDate },
  { session = null, canSeeConfidential = false }: ApprovedTimeOffOptions = {},
): Promise<DtrTimeOffInput[]> {
  if (to < from) return [];
  await connectDb();
  const requests = await TimeOffRequestModel.find({
    employeeId: new Types.ObjectId(employeeId),
    status: 'approved',
    startDate: { $lte: instantOf(to) },
    endDate: { $gte: instantOf(from) },
  })
    .sort({ startDate: 1, _id: 1 })
    .session(session)
    .lean<TimeOffRequestDocument[]>();
  if (requests.length === 0) return [];
  const spanFrom = requests.map((r) => dayOf(r.startDate)).reduce((a, b) => (b < a ? b : a));
  const spanTo = requests.map((r) => dayOf(r.endDate)).reduce((a, b) => (b > a ? b : a));
  const [context, settings] = await Promise.all([
    loadTimeOffContext(employeeId, subject, { from: spanFrom, to: spanTo }, session),
    leaveSettingsOn(undefined, { session }),
  ]);
  const inputs: DtrTimeOffInput[] = [];
  for (const request of requests) {
    const type = typeOfRequest(settings, request);
    const shortName = dtrShortNameOf(request, type, canSeeConfidential);
    for (const day of storedRequestDays(request, type, context)) {
      if (day.date < from || day.date > to) continue;
      inputs.push(...dtrInputsOfDay(request, day, shortName));
    }
  }
  return inputs;
}
