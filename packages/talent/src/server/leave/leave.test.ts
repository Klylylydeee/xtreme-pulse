import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Types } from 'mongoose';
import { connectDb, withTransaction } from '@pulse/db';
import { AccessDeniedError } from '@pulse/core';
import { LEAVE_ENTRY_TYPE } from '../../time-off/kinds';
import {
  auditEntries,
  database,
  type Department,
  department,
  type Person,
  person,
  seedPayrollSettings,
  separate,
  setLeaveSettings,
  setRegularizationDate,
  setReportingTo,
  storedTimeOffRequest,
} from '../testing/fixtures';
import { LEAVE_CREDITS_JOB, LEAVE_CREDITS_SCHEDULE, runLeaveCredits } from './credits';
import { LeaveEntryModel } from './model';
import {
  availableLeaveHalfDaysOf,
  getLeaveBalances,
  leaveBalanceOf,
  listLeaveEntries,
  writeLeaveAdjustment,
  writeLeaveUsage,
} from './service';

// Leave balances and crediting (docs/TESTING.md#leave-and-time-off-tests: "Crediting and
// carry-over", L11 and L12; decisions 303–306 and 311 in docs/BUILD_PLAN.md). Made-up people only.
// "Today" is Monday 2026-10-19, 10:00 Manila. The go-live date is 2026-03-01, from a version that
// takes effect on 2026-01-15 (before that, the seeded version has none).

const TODAY = new Date('2026-10-19T10:00:00+08:00');
const at = (day: string) => new Date(`${day}T00:30:00+08:00`);

let NET: Department;
let HRD: Department;
let hr: Person;
let boss: Person;
let outsider: Person;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(TODAY);
});

afterEach(() => {
  vi.useRealTimers();
});

beforeAll(async () => {
  await connectDb();
  await LeaveEntryModel.init();
  await seedPayrollSettings();
  NET = await department('Network', 'NET');
  HRD = await department('Human Resource', 'HR');
  hr = await person('Hana', 'Reyes', HRD, { talent: 'write' });
  boss = await person('Bea', 'Tan', NET);
  outsider = await person('Otto', 'Gomez', NET);
  await setLeaveSettings({ goLiveDate: '2026-03-01' }, '2026-01-15');
});

let count = 0;
async function regular(regularizationDate: string | null, status: 'Regular' = 'Regular') {
  count += 1;
  const p = await person('Test', `Person${count}`, NET, { status, dateHired: '2025-01-01' });
  await setReportingTo(p, [boss]);
  await setRegularizationDate(p, regularizationDate);
  return p;
}

async function entriesOf(p: Person) {
  return database()
    .collection('leaveEntries')
    .find({ employeeId: new Types.ObjectId(p.employeeId) })
    .sort({ effectiveOn: 1, _id: 1 })
    .toArray();
}

const halfDaysOf = async (p: Person, typeKey: string) =>
  (await entriesOf(p)).filter((e) => e.typeKey === typeKey).map((e) => [e.kind, e.halfDays]);

describe('the job', () => {
  it('runs daily at 00:30 Manila', () => {
    expect(LEAVE_CREDITS_JOB.name).toBe('talent.leaveCredits');
    expect(LEAVE_CREDITS_SCHEDULE.pattern).toBe('30 0 * * *');
  });

  it('writes nothing while the go-live date is null', async () => {
    const p = await regular('2025-06-01');
    const result = await runLeaveCredits(at('2026-01-10'));
    expect(result).toMatchObject({ goLiveDate: null, written: 0 });
    expect(await entriesOf(p)).toEqual([]);
  });
});

describe('crediting (L11)', () => {
  it('credits 4.0 and 3.5 days at regularization on April 10 and April 20, for VL and SL', async () => {
    const april10 = await regular('2026-04-10');
    const april20 = await regular('2026-04-20');
    await runLeaveCredits(TODAY);
    expect(await halfDaysOf(april10, 'vacation')).toEqual([['credit', 8]]);
    expect(await halfDaysOf(april10, 'sick')).toEqual([['credit', 8]]);
    expect(await halfDaysOf(april20, 'vacation')).toEqual([['credit', 7]]);
    const [entry] = await entriesOf(april10);
    expect(entry).toMatchObject({ year: 2026, createdBy: null, sourceType: null });
    expect((entry?.effectiveOn as Date).toISOString()).toBe('2026-04-09T16:00:00.000Z');
  });

  it('counts the regularization month on the 15th but not the 16th', async () => {
    const may15 = await regular('2026-05-15');
    const may16 = await regular('2026-05-16');
    await runLeaveCredits(TODAY);
    // 8 months: 3.33 → 3.5 days; 7 months: 2.92 → 3.0 days.
    expect(await halfDaysOf(may15, 'vacation')).toEqual([['credit', 7]]);
    expect(await halfDaysOf(may16, 'vacation')).toEqual([['credit', 6]]);
  });

  it('writes nothing dated before the go-live date, and no back-fill of an earlier year', async () => {
    const beforeGoLive = await regular('2026-02-10');
    const lastYear = await regular('2025-06-01');
    await runLeaveCredits(TODAY);
    expect(await entriesOf(beforeGoLive)).toEqual([]);
    // Its 2026-01-01 credit falls before the go-live date; 2025 is never back-filled.
    expect(await entriesOf(lastYear)).toEqual([]);
  });

  it('credits no Probationary, Contractual or separated employee, nor a Regular one without a date', async () => {
    const probationary = await person('Pia', 'Cruz', NET, { status: 'Probationary' });
    await setRegularizationDate(probationary, '2026-04-10');
    const contractual = await person('Carl', 'Lim', NET, { status: 'Contractual' });
    await setRegularizationDate(contractual, '2026-04-10');
    const gone = await regular('2026-04-10');
    await separate(gone);
    const noDate = await regular(null);
    const later = await regular('2026-12-01');
    await runLeaveCredits(TODAY);
    for (const p of [probationary, contractual, gone, noDate, later]) {
      expect(await entriesOf(p)).toEqual([]);
    }
  });

  it('is idempotent: a second run, or two at once, writes nothing more', async () => {
    const p = await regular('2026-06-01');
    const [first, second] = await Promise.all([runLeaveCredits(TODAY), runLeaveCredits(TODAY)]);
    expect((first?.written ?? 0) + (second?.written ?? 0)).toBeGreaterThanOrEqual(2);
    const again = await runLeaveCredits(TODAY);
    expect(again.written).toBe(0);
    expect(await halfDaysOf(p, 'vacation')).toEqual([['credit', 6]]);
    expect(await halfDaysOf(p, 'sick')).toHaveLength(1);
  });

  it('audits each entry with no actor, labelled with the number, short name and day', async () => {
    const p = await regular('2026-07-01');
    await runLeaveCredits(TODAY);
    const [entry] = await entriesOf(p);
    const audit = (await auditEntries(LEAVE_ENTRY_TYPE)).find(
      (row) => String(row.record.id) === String(entry?._id),
    );
    expect(audit).toMatchObject({
      action: 'create',
      actorId: null,
      module: 'talent',
      record: { label: `${p.employeeNumber} · VL · 2026-07-01` },
    });
  });
});

describe('balances', () => {
  it('sums the entries; the available balance holds back other pending requests', async () => {
    const p = await regular('2026-04-10');
    await runLeaveCredits(TODAY);
    await storedTimeOffRequest(p, {
      kind: 'leave',
      status: 'pending',
      leaveTypeKey: 'vacation',
      startDate: '2026-11-02',
      chargeableHalfDays: 2,
      paidHalfDays: 2,
    });
    const rejected = await storedTimeOffRequest(p, {
      kind: 'leave',
      status: 'rejected',
      leaveTypeKey: 'vacation',
      startDate: '2026-11-03',
      chargeableHalfDays: 2,
      paidHalfDays: 2,
    });
    const own = await getLeaveBalances(p.actor, p.employeeId);
    expect(own?.balances.find((b) => b.typeKey === 'vacation')).toMatchObject({
      shortName: 'VL',
      balanceHalfDays: 8,
      availableHalfDays: 6,
      pendingHalfDays: 2,
    });
    expect(own?.regularizationDateMissing).toBe(false);
    expect(await leaveBalanceOf(p.employeeId, 'vacation')).toBe(8);
    expect(await availableLeaveHalfDaysOf(p.employeeId, 'vacation')).toBe(6);
    expect(
      await availableLeaveHalfDaysOf(p.employeeId, 'vacation', { exceptRequestId: rejected }),
    ).toBe(6);
  });

  it('shows the per-year use, and hides a confidential type from a supervisor', async () => {
    const p = await regular('2026-04-10');
    await storedTimeOffRequest(p, {
      kind: 'leave',
      status: 'approved',
      leaveTypeKey: 'soloParent',
      startDate: '2026-09-01',
      chargeableHalfDays: 4,
    });
    await storedTimeOffRequest(p, {
      kind: 'leave',
      status: 'pending',
      leaveTypeKey: 'vawc',
      startDate: '2026-11-03',
      chargeableHalfDays: 2,
    });
    const own = await getLeaveBalances(p.actor, p.employeeId);
    expect(own?.perYear.map((u) => [u.typeKey, u.usedHalfDays, u.limitHalfDays])).toEqual([
      ['soloParent', 4, 14],
      ['vawc', 2, 20],
    ]);
    const supervisor = await getLeaveBalances(boss.actor, p.employeeId);
    expect(supervisor?.perYear.map((u) => u.typeKey)).toEqual(['soloParent']);
    expect((await getLeaveBalances(hr.actor, p.employeeId))?.perYear).toHaveLength(2);
  });

  it('flags a Regular employee without a regularization date', async () => {
    const p = await regular(null);
    expect((await getLeaveBalances(hr.actor, p.employeeId))?.regularizationDateMissing).toBe(true);
  });

  it('refuses anyone who may not see the time off, and is null for no employee', async () => {
    const p = await regular('2026-04-10');
    await expect(getLeaveBalances(outsider.actor, p.employeeId)).rejects.toBeInstanceOf(
      AccessDeniedError,
    );
    await expect(listLeaveEntries(outsider.actor, p.employeeId)).rejects.toBeInstanceOf(
      AccessDeniedError,
    );
    expect(await getLeaveBalances(hr.actor, new Types.ObjectId().toHexString())).toBeNull();
  });
});

describe('the writers', () => {
  it('writes usage and adjustment entries in the caller’s transaction, audited, and 0 writes nothing', async () => {
    const p = await regular('2026-04-10');
    const requestId = new Types.ObjectId();
    await withTransaction(async (session) => {
      await writeLeaveUsage(
        {
          employeeId: p.employeeId,
          typeKey: 'vacation',
          halfDays: -2,
          effectiveOn: '2026-11-02',
          requestId,
        },
        { userId: boss.userId, email: boss.actor.email },
        session,
      );
      await writeLeaveAdjustment(
        {
          employeeId: p.employeeId,
          typeKey: 'vacation',
          halfDays: 1,
          effectiveOn: '2026-10-19',
          reason: 'Holiday changed: 2026-11-30',
          requestId,
        },
        null,
        session,
      );
      expect(
        await writeLeaveUsage(
          {
            employeeId: p.employeeId,
            typeKey: 'vacation',
            halfDays: 0,
            effectiveOn: '2026-11-02',
            requestId,
          },
          null,
          session,
        ),
      ).toBeNull();
    });
    const rows = await entriesOf(p);
    expect(
      rows.map((row) => [row.kind, row.halfDays, row.sourceType, String(row.sourceId)]),
    ).toEqual([
      ['adjustment', 1, 'talent.timeOffRequest', String(requestId)],
      ['usage', -2, 'talent.timeOffRequest', String(requestId)],
    ]);
    expect(await leaveBalanceOf(p.employeeId, 'vacation')).toBe(-1);
    const entries = await listLeaveEntries(p.actor, p.employeeId);
    expect(entries?.map((entry) => entry.kind)).toEqual(['usage', 'adjustment']);
  });

  it('never changes or deletes an entry', async () => {
    const p = await regular('2026-04-10');
    await runLeaveCredits(TODAY);
    const [entry] = await entriesOf(p);
    await expect(
      LeaveEntryModel.updateOne({ _id: entry?._id }, { $set: { halfDays: 99 } }),
    ).rejects.toThrow();
    await expect(LeaveEntryModel.deleteOne({ _id: entry?._id })).rejects.toThrow();
  });
});

describe('January 1 (L12)', () => {
  it('carries over with no cap, then credits the full year; a future credit isn’t available', async () => {
    const p = await regular('2026-04-10');
    await runLeaveCredits(TODAY);
    await withTransaction((session) =>
      writeLeaveUsage(
        {
          employeeId: p.employeeId,
          typeKey: 'vacation',
          halfDays: -1,
          effectiveOn: '2026-11-02',
          requestId: new Types.ObjectId(),
        },
        null,
        session,
      ),
    );
    // 3.5 days at the end of 2026.
    expect(await leaveBalanceOf(p.employeeId, 'vacation')).toBe(7);
    await runLeaveCredits(at('2027-01-01'));
    expect(await halfDaysOf(p, 'vacation')).toEqual([
      ['credit', 8],
      ['usage', -1],
      ['carryOver', 0],
      ['credit', 10],
    ]);
    expect(await leaveBalanceOf(p.employeeId, 'vacation')).toBe(17);
    expect(await availableLeaveHalfDaysOf(p.employeeId, 'vacation', { today: '2026-12-31' })).toBe(
      7,
    );
    // Running again on a later day of 2027 adds nothing.
    expect((await runLeaveCredits(at('2027-01-05'))).written).toBe(0);
  });

  it('carries over only up to the cap: 3.5 days with a cap of 2 leave 7.0 days', async () => {
    const p = await regular('2026-04-10');
    await runLeaveCredits(TODAY);
    await withTransaction((session) =>
      writeLeaveUsage(
        {
          employeeId: p.employeeId,
          typeKey: 'vacation',
          halfDays: -1,
          effectiveOn: '2026-11-02',
          requestId: new Types.ObjectId(),
        },
        null,
        session,
      ),
    );
    const { SEED_LEAVE_SETTINGS } = await import('../../time-off/settings');
    await setLeaveSettings(
      {
        goLiveDate: '2026-03-01',
        types: SEED_LEAVE_SETTINGS.types.map((type) =>
          type.key === 'vacation' && type.crediting
            ? { ...type, crediting: { ...type.crediting, carryOverCapDays: '2' } }
            : type,
        ),
      },
      '2026-12-31',
    );
    await runLeaveCredits(at('2027-01-01'));
    expect(await halfDaysOf(p, 'vacation')).toEqual([
      ['credit', 8],
      ['usage', -1],
      ['carryOver', -3],
      ['credit', 10],
    ]);
    expect(await leaveBalanceOf(p.employeeId, 'vacation')).toBe(14);
  });
});
