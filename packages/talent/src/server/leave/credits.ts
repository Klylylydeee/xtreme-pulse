import { z } from 'zod';
import { Types } from 'mongoose';
import { connectDb, withTransaction } from '@pulse/db';
import { addDays, type BusinessDate, now, toBusinessDate } from '@pulse/core';
import {
  defineJob,
  defineSchedule,
  type EmployeeIdentity,
  type IdentityActor,
  listEmployeeIdentities,
  resolveModuleAccess,
} from '@pulse/core/server';
import {
  carryOverHalfDays,
  leaveBalanceOn,
  type PlannedLeaveEntry,
  plannedLeaveCredits,
} from '../../time-off/balance';
import { creditedLeaveTypes, type LeaveType } from '../../time-off/settings';
import { EmployeeRecordModel } from '../employee-records/model';
import { leaveSettingsOn } from '../payroll-settings/settings';
import { dayOf, isDuplicateKey } from '../shared';
import { LeaveEntryModel } from './model';
import { insertLeaveEntry, leaveEntriesOf } from './service';

// Spec: docs/ARCHITECTURE.md#background-jobs ("Leave credits") and
// docs/modules/talent.md#leave-offset-time-off-and-opening-balances-build-step-28 ("Crediting";
// decisions 304–306 in docs/BUILD_PLAN.md) — the daily job `talent.leaveCredits`, at 00:30 Manila.
//
// - For every active (not separated) Regular employee with a regularization date on or before
//   today, and every active `credited` type: the regularization credit in the regularization year
//   (prorated, dated the regularization date), and from the next year, on `annualCreditOn`, the
//   `carryOver` for the balance at the end of the day before and then the full `credit`, both
//   dated that day. The pure plan is `plannedLeaveCredits`; the carry-over is worked out here
//   from the stored entries, in the same transaction as its credit.
// - Only the current year, nothing dated before the go-live date, and nothing while it is null
//   (the go-live gate, decision 306). Probationary and Contractual employees, and a Regular one
//   with no regularization date, get nothing.
// - Idempotent: the partial unique index on `{ employeeId, typeKey, kind, year }` refuses a second
//   credit or carry-over, and a run skips what is already written. A missed day catches up.
// - Audit: `create` on `talent.leaveEntry` with no actor (a system action). No notification
//   (*Assumption*, HANDOFF item 176).

/** The job: no data, everything is read when it runs. */
export const LEAVE_CREDITS_JOB = defineJob('talent.leaveCredits', { schema: z.object({}) });

/** Every day at 00:30 Manila. */
export const LEAVE_CREDITS_SCHEDULE = defineSchedule({
  id: 'talent.leaveCredits',
  job: LEAVE_CREDITS_JOB,
  data: {},
  pattern: '30 0 * * *',
});

export interface LeaveCreditsResult {
  /** The Manila day the run was for. */
  date: BusinessDate;
  /** `talent.leaveSettings.goLiveDate` that day; null means nothing was written. */
  goLiveDate: BusinessDate | null;
  /** Regular employees with a regularization date on or before the day (the ones considered). */
  employees: number;
  /** Entries written in this run (credits and carry-overs). */
  written: number;
  /** Planned entries already written by an earlier run. */
  existing: number;
}

/**
 * The job reads Core's identities with Talent Read and no employee: it has no user, and sends
 * nothing anywhere. Only the employee id, number, status and separation are used.
 */
const JOB_READER: IdentityActor = {
  employee: null,
  moduleAccess: resolveModuleAccess({
    isSystemAdministrator: false,
    moduleAccess: { talent: 'read' },
  }),
};

const keyOf = (employeeId: string, typeKey: string, kind: string) =>
  `${employeeId}:${typeKey}:${kind}`;

/**
 * Writes one employee's planned entries for one type that aren't written yet, in one transaction
 * (so a carry-over is never left without its credit). Returns how many it wrote.
 */
async function writePlanned(
  identity: EmployeeIdentity,
  type: LeaveType,
  planned: PlannedLeaveEntry[],
): Promise<number> {
  return withTransaction(async (session) => {
    const year = planned[0]?.year;
    const written = await LeaveEntryModel.find(
      {
        employeeId: new Types.ObjectId(identity.employeeId),
        typeKey: type.key,
        year,
      },
      { kind: 1 },
    )
      .session(session)
      .lean<{ kind: string }[]>();
    const done = new Set(written.map((entry) => entry.kind));
    let count = 0;
    for (const entry of planned) {
      if (done.has(entry.kind)) continue;
      let halfDays = entry.halfDays;
      if (halfDays === null) {
        // The carry-over: the balance at the end of the day before the credit date.
        const entries = await leaveEntriesOf(identity.employeeId, type.key, { session });
        const before = leaveBalanceOn(
          entries.map((row) => ({ halfDays: row.halfDays, effectiveOn: dayOf(row.effectiveOn) })),
          addDays(entry.effectiveOn, -1),
        );
        halfDays = carryOverHalfDays(type, before);
      }
      await insertLeaveEntry(
        {
          employeeId: identity.employeeId,
          typeKey: type.key,
          kind: entry.kind,
          halfDays,
          effectiveOn: entry.effectiveOn,
          year: entry.year,
        },
        { employeeNumber: identity.employeeNumber, shortName: type.shortName },
        null,
        session,
      );
      count += 1;
    }
    return count;
  });
}

/** Writes today's leave credits and carry-overs (the Manila day of `at`). Safe to run again. */
export async function runLeaveCredits(at: Date = now()): Promise<LeaveCreditsResult> {
  await connectDb();
  const date = toBusinessDate(at);
  const settings = await leaveSettingsOn(date);
  const goLiveDate = settings.goLiveDate;
  const result: LeaveCreditsResult = { date, goLiveDate, employees: 0, written: 0, existing: 0 };
  const types = creditedLeaveTypes(settings);
  if (goLiveDate === null || types.length === 0) return result;

  // Active employees only: retired and separated ones are never credited.
  const identities = (await listEmployeeIdentities(JOB_READER)).filter(
    (identity) => !identity.separated && identity.employmentStatus === 'Regular',
  );
  if (identities.length === 0) return result;
  const records = await EmployeeRecordModel.find(
    {
      employeeId: { $in: identities.map((identity) => new Types.ObjectId(identity.employeeId)) },
      regularizationDate: { $ne: null },
    },
    { employeeId: 1, regularizationDate: 1 },
  ).lean<{ employeeId: Types.ObjectId; regularizationDate: Date }[]>();
  const regularizedOn = new Map(
    records.map((record) => [record.employeeId.toHexString(), dayOf(record.regularizationDate)]),
  );

  const year = Number(date.slice(0, 4));
  const already = new Set(
    (
      await LeaveEntryModel.find(
        { year, kind: { $in: ['credit', 'carryOver'] } },
        { employeeId: 1, typeKey: 1, kind: 1 },
      ).lean<{ employeeId: Types.ObjectId; typeKey: string; kind: string }[]>()
    ).map((entry) => keyOf(entry.employeeId.toHexString(), entry.typeKey, entry.kind)),
  );

  for (const identity of identities) {
    const regularizationDate = regularizedOn.get(identity.employeeId) ?? null;
    if (!regularizationDate || regularizationDate > date) continue;
    result.employees += 1;
    for (const type of types) {
      const planned = plannedLeaveCredits({
        today: date,
        goLiveDate,
        type,
        employmentStatus: identity.employmentStatus,
        regularizationDate,
        active: !identity.separated,
      });
      const missing = planned.filter(
        (entry) => !already.has(keyOf(identity.employeeId, type.key, entry.kind)),
      );
      result.existing += planned.length - missing.length;
      if (missing.length === 0) continue;
      try {
        const written = await writePlanned(identity, type, missing);
        result.written += written;
        result.existing += missing.length - written;
      } catch (error) {
        // Another run wrote them at the same moment (the unique index): nothing to add.
        if (!isDuplicateKey(error)) throw error;
        result.existing += missing.length;
      }
    }
  }
  return result;
}
