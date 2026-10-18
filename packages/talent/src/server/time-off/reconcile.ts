import { type Types } from 'mongoose';
import { connectDb, withTransaction } from '@pulse/db';
import { type BusinessDate, businessToday } from '@pulse/core';
import { notify, recordAudit, snapshotsForAudit } from '@pulse/core/server';
import {
  holidayChangedReason,
  OFFSET_ADJUSTED_EVENT,
  offsetAdjustedMessage,
} from '../../offset/entries';
import { reconcileLeaveSplit, reconcileOffsetMinutes } from '../../time-off/balance';
import { chargeableHalfDaysOf, chargeableMinutesOf } from '../../time-off/days';
import {
  LEAVE_ADJUSTED_EVENT,
  TIME_OFF_REQUEST_TYPE,
  timeOffRequestHref,
} from '../../time-off/kinds';
import { leaveAdjustedMessage } from '../../time-off/views';
import { availableLeaveHalfDaysOf, writeLeaveAdjustment } from '../leave/service';
import { writeOffsetUsage } from '../offset/service';
import { leaveSettingsOn } from '../payroll-settings/settings';
import { dayOf, instantOf } from '../shared';
import { serviceIdentity } from '../timesheets/access';
import { timeOffAuditLabel } from './approval';
import { recountStoredRequest } from './checks';
import { touchTimeOffLock } from './lock';
import { type TimeOffRequestDocument, TimeOffRequestModel } from './model';

// Spec: docs/modules/talent.md#leave-offset-time-off-and-opening-balances-build-step-28 ("The
// holidays-changed listener"; decision 316 in docs/BUILD_PLAN.md) — the part of
// `talent.recomputeDtr` that reconciles every **approved** request covering a changed date, each
// in its own transaction, idempotently:
//
// - The chargeable half days (leave) or minutes (offset) are counted again against the confirmed
//   holidays now. When they fall (a holiday confirmed inside the request), the difference comes
//   back: leave from its unpaid days first, as an `adjustment` ("Holiday changed: <dates>"),
//   offset as a `usage` entry. When they rise (a holiday deleted), leave is charged from the
//   available balance and the rest is unpaid; offset is charged, even below zero (*Assumption*,
//   HANDOFF item 167).
// - The stored split changes with it (an `update` entry), every entry is its own `create`, all
//   with no actor; the employee is told (`talent.leaveAdjusted`, or step 2.7's
//   `talent.offsetAdjusted`). A second run finds nothing to change.
// - A finalized payroll period's pay difference is step 2.9's adjustment.

export interface TimeOffReconcileResult {
  /** Approved requests covering a changed date. */
  requests: number;
  /** Requests whose charge changed in this run. */
  adjusted: number;
}

/** Reconciles one approved request in its own transaction; true when its charge changed. */
async function reconcileRequest(
  requestId: Types.ObjectId,
  dates: readonly BusinessDate[],
): Promise<boolean> {
  return withTransaction(async (session) => {
    const before = await TimeOffRequestModel.findById(requestId)
      .session(session)
      .lean<TimeOffRequestDocument>();
    if (!before || before.status !== 'approved') return false;
    const employeeId = before.employeeId.toHexString();
    const identity = await serviceIdentity(employeeId, { session });
    if (!identity) return false;
    const today = businessToday();
    const settings = await leaveSettingsOn(today, { session });
    const { type, days } = await recountStoredRequest(before, identity, settings, session);
    const start = dayOf(before.startDate);
    const end = dayOf(before.endDate);
    const changed = dates.filter((date) => date >= start && date <= end);
    const reason = holidayChangedReason(changed);

    let set: Record<string, unknown>;
    let notice: { event: string; title: string } | null = null;
    if (before.kind === 'offset') {
      const minutes = chargeableMinutesOf(days);
      const giveBack = reconcileOffsetMinutes(before.minutes ?? 0, minutes);
      if (giveBack === 0) return false;
      await touchTimeOffLock(before.employeeId, session);
      await writeOffsetUsage(
        { employeeId, minutes: giveBack, effectiveOn: today, requestId: before._id, reason },
        null,
        session,
      );
      set = { minutes };
      notice = { event: OFFSET_ADJUSTED_EVENT, title: offsetAdjustedMessage(giveBack, changed) };
    } else {
      const chargeable = chargeableHalfDaysOf(days);
      if (chargeable === before.chargeableHalfDays) return false;
      await touchTimeOffLock(before.employeeId, session);
      const credited = type?.balance === 'credited';
      const available = credited
        ? await availableLeaveHalfDaysOf(before.employeeId, type.key, { today, session })
        : 0;
      const { split, balanceChangeHalfDays } = reconcileLeaveSplit(
        {
          chargeableHalfDays: before.chargeableHalfDays ?? 0,
          paidHalfDays: before.paidHalfDays,
          unpaidHalfDays: before.unpaidHalfDays,
        },
        chargeable,
        available,
      );
      if (credited && balanceChangeHalfDays !== 0) {
        await writeLeaveAdjustment(
          {
            employeeId,
            typeKey: type.key,
            halfDays: balanceChangeHalfDays,
            effectiveOn: today,
            reason,
            requestId: before._id,
          },
          null,
          session,
        );
      }
      set = { ...split };
      notice = {
        event: LEAVE_ADJUSTED_EVENT,
        // The employee reads their own type's name, a confidential one included.
        title: leaveAdjustedMessage(type?.shortName ?? 'leave', balanceChangeHalfDays, changed),
      };
    }

    const after = await TimeOffRequestModel.findOneAndUpdate(
      { _id: before._id, version: before.version, status: 'approved' },
      { $set: { ...set, updatedBy: null }, $inc: { version: 1 } },
      { session, returnDocument: 'after', runValidators: true },
    ).lean<TimeOffRequestDocument>();
    if (!after) throw new Error('The time off request changed while it was being reconciled.');
    await recordAudit(
      {
        actorId: null,
        actorEmail: null,
        module: 'talent',
        action: 'update',
        record: { type: TIME_OFF_REQUEST_TYPE, id: before._id, label: timeOffAuditLabel(before) },
        ...snapshotsForAudit(TimeOffRequestModel, before, after),
        reason,
      },
      { session },
    );
    if (notice && identity.userId && identity.active && !identity.separated) {
      await notify(
        {
          recipients: [identity.userId],
          module: 'talent',
          event: notice.event,
          title: notice.title,
          href: timeOffRequestHref(before._id.toHexString()),
          record: { type: TIME_OFF_REQUEST_TYPE, id: before._id },
        },
        { session },
      );
    }
    return true;
  });
}

/**
 * The holidays-changed listener's time off work (decision 316): reconciles every approved request
 * covering one of `dates`. Pending requests need nothing: approval counts them again. Idempotent.
 */
export async function reconcileTimeOffRequests(
  dates: readonly BusinessDate[],
): Promise<TimeOffReconcileResult> {
  const sorted = [...new Set(dates)].sort();
  const first = sorted[0];
  const last = sorted[sorted.length - 1];
  if (!first || !last) return { requests: 0, adjusted: 0 };
  await connectDb();
  const candidates = await TimeOffRequestModel.find(
    {
      status: 'approved',
      startDate: { $lte: instantOf(last) },
      endDate: { $gte: instantOf(first) },
    },
    { startDate: 1, endDate: 1 },
  ).lean<Pick<TimeOffRequestDocument, '_id' | 'startDate' | 'endDate'>[]>();
  const affected = candidates.filter((request) => {
    const start = dayOf(request.startDate);
    const end = dayOf(request.endDate);
    return sorted.some((date) => date >= start && date <= end);
  });
  let adjusted = 0;
  for (const request of affected) {
    if (await reconcileRequest(request._id, sorted)) adjusted += 1;
  }
  return { requests: affected.length, adjusted };
}
