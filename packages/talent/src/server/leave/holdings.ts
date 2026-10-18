import mongoose, { type ClientSession, Types } from 'mongoose';
import { connectDb } from '@pulse/db';
import { isApproverFor } from '@pulse/core/server';
import { toBusinessDate } from '@pulse/core';
import { TIME_OFF_REQUEST_TYPE, type TimeOffKind, type TimeOffStatus } from '../../time-off/kinds';

// Spec: docs/modules/talent.md#leave-offset-time-off-and-opening-balances-build-step-28
// ("Insufficient balance", "Filing offset time off", "Who may see what"; decisions 303, 311, 312
// and 318 in docs/BUILD_PLAN.md) — what time off requests hold against a balance, read for the
// balance services: the paid half days of pending leave, the minutes of pending offset time off,
// a `perYear` type's use, and whether a user is an approver on any of an employee's requests.
//
// `timeOffRequests` is Talent's own collection (DATA_MODEL.md), modelled by the time off service
// (server/time-off/). These reads use its documented field names directly so the balance services
// don't depend on that service, which in turn writes its usage entries through them. Read-only;
// nothing here writes the collection.

const COLLECTION = 'timeOffRequests';

/** The fields of a stored request these reads use (docs/DATA_MODEL.md, `timeOffRequests`). */
interface HoldingRow {
  _id: Types.ObjectId;
  kind: TimeOffKind;
  leaveTypeKey: string | null;
  status: TimeOffStatus;
  startDate: Date;
  chargeableHalfDays: number | null;
  paidHalfDays: number | null;
  minutes: number | null;
}

interface ReadOptions {
  /** Leave this request out (the one being filed again or approved). */
  exceptRequestId?: string | Types.ObjectId | null;
  session?: ClientSession | null;
}

function idOf(id: string | Types.ObjectId): Types.ObjectId {
  return typeof id === 'string' ? new Types.ObjectId(id) : id;
}

async function rows(
  filter: Record<string, unknown>,
  { exceptRequestId = null, session = null }: ReadOptions,
): Promise<HoldingRow[]> {
  await connectDb();
  const db = mongoose.connection.db;
  if (!db) throw new Error('Not connected.');
  const query = exceptRequestId ? { ...filter, _id: { $ne: idOf(exceptRequestId) } } : filter;
  return db
    .collection<HoldingRow>(COLLECTION)
    .find(query, {
      projection: {
        kind: 1,
        leaveTypeKey: 1,
        status: 1,
        startDate: 1,
        chargeableHalfDays: 1,
        paidHalfDays: 1,
        minutes: 1,
      },
      session: session ?? undefined,
    })
    .toArray();
}

/**
 * The paid half days each of the employee's pending requests of `typeKey` holds (a `credited`
 * type), for `availableLeaveHalfDays`. A request with no stored split holds nothing.
 */
export async function pendingLeavePaidHalfDays(
  employeeId: string | Types.ObjectId,
  typeKey: string,
  options: ReadOptions = {},
): Promise<number[]> {
  const found = await rows(
    { employeeId: idOf(employeeId), kind: 'leave', leaveTypeKey: typeKey, status: 'pending' },
    options,
  );
  return found.map((row) => row.paidHalfDays ?? 0);
}

/** The minutes each of the employee's pending offset time off requests holds. */
export async function pendingOffsetMinutes(
  employeeId: string | Types.ObjectId,
  options: ReadOptions = {},
): Promise<number[]> {
  const found = await rows(
    { employeeId: idOf(employeeId), kind: 'offset', status: 'pending' },
    options,
  );
  return found.map((row) => row.minutes ?? 0);
}

/**
 * A `perYear` type's use in `year`: the chargeable half days of the employee's approved and
 * pending requests of `typeKey` starting that year. A request across December 31 counts in its
 * first day's year here (*Assumption*, HANDOFF item 185); filing checks each day's own year.
 */
export async function perYearUsedHalfDays(
  employeeId: string | Types.ObjectId,
  typeKey: string,
  year: number,
  options: ReadOptions = {},
): Promise<number> {
  const found = await rows(
    {
      employeeId: idOf(employeeId),
      kind: 'leave',
      leaveTypeKey: typeKey,
      status: { $in: ['pending', 'approved'] },
    },
    options,
  );
  return found
    .filter((row) => Number(toBusinessDate(row.startDate).slice(0, 4)) === year)
    .reduce((sum, row) => sum + (row.chargeableHalfDays ?? 0), 0);
}

/**
 * True when `userId` is or was an approver on any of the employee's time off requests (Core's
 * `isApproverFor` on the record `talent.timeOffRequest`), which lets them see the
 * employee's requests and balances read-only (decision 318).
 */
export async function isTimeOffApproverOf(
  userId: string,
  employeeId: string | Types.ObjectId,
): Promise<boolean> {
  const found = await rows({ employeeId: idOf(employeeId) }, {});
  for (const row of found) {
    if (await isApproverFor(userId, TIME_OFF_REQUEST_TYPE, row._id.toHexString())) return true;
  }
  return false;
}

/** The record type a usage or listener entry points at (`sourceType`). */
export const TIME_OFF_SOURCE_TYPE = TIME_OFF_REQUEST_TYPE;
