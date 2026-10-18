import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Types } from 'mongoose';
import { connectDb } from '@pulse/db';
import { AccessDeniedError, ActionError } from '@pulse/core';
import { addConfigVersion, runHolidaysChangedListeners } from '@pulse/core/server';
import { OFFSET_ADJUSTED_EVENT, OFFSET_ENTRY_TYPE } from '../../offset/entries';
import { RECOMPUTE_DTR_LISTENER, registerTalentHolidaysChangedListener } from '../dtr/listener';
import { getDtr } from '../dtr/service';
import { registerTalentApprovalTypes } from '../change-requests/service';
import { registerTalentApprovalSigner, uploadESignature } from '../e-signatures/service';
import { TIMESHEET_SETTINGS_SETTING } from '../payroll-settings/settings';
import {
  auditEntries,
  database,
  decide,
  type Department,
  department,
  holiday,
  notifications,
  type Person,
  person,
  pngFile,
  seedPayrollSettings,
  setHoliday,
  setPositionType,
  setReportingTo,
} from '../testing/fixtures';
import { TimeEntryModel, TimesheetModel } from '../timesheets/model';
import { createTimeEntry, getOwnTimesheetView } from '../timesheets/service';
import { submitTimesheet } from '../timesheets/submission';
import { OffsetEntryModel } from './model';
import { getOffsetBalance, reconcileOffsetCredits } from './service';

// The offset balance, the DTR service and the holidays-changed listener
// (docs/TESTING.md#timesheet-approval-dtr-and-offset-tests: "The offset balance", "The
// holidays-changed listener"; decisions 286–288 and 292 in docs/BUILD_PLAN.md). Made-up people
// only. "Today" is Friday 2026-12-11, 10:00 Manila: the cut-off 2026-11-26 to 2026-12-10 has ended.

const CUT_OFF = '2026-11-26';
const TODAY = new Date('2026-12-11T10:00:00+08:00');

let storageDir: string;
let NET: Department;
let OFF: Department;
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
  storageDir = await mkdtemp(path.join(tmpdir(), 'pulse-test-storage-'));
  process.env.FILE_STORAGE_DIR = storageDir;
  await connectDb();
  await Promise.all([TimesheetModel.init(), TimeEntryModel.init(), OffsetEntryModel.init()]);
  await seedPayrollSettings();
  NET = await department('Network', 'NET');
  OFF = await department('Office', 'OFF');
  await setPositionType(OFF, 'standard');
  HRD = await department('Human Resource', 'HR');
  hr = await person('Hana', 'Reyes', HRD, { talent: 'write' });
  boss = await person('Bea', 'Tan', NET);
  outsider = await person('Otto', 'Gomez', NET);
  for (const approver of [hr, boss]) await uploadESignature(approver.actor, pngFile());
  registerTalentApprovalSigner();
  registerTalentApprovalTypes();
});

afterAll(async () => {
  await rm(storageDir, { recursive: true, force: true });
});

let count = 0;
async function employee(dept: Department = OFF): Promise<Person> {
  count += 1;
  const p = await person('Test', `Person${count}`, dept, { dateHired: '2025-01-01' });
  await setReportingTo(p, [boss]);
  return p;
}

const marked = (p: Person, date: string, timeIn: string, timeOut: string) =>
  createTimeEntry(p.actor, {
    date,
    timeIn,
    timeOut,
    activity: 'Site survey',
    clientId: null,
    extraHoursReason: 'Cut-over window',
  });

async function timesheetOf(p: Person, cutOff = CUT_OFF): Promise<string> {
  const view = await getOwnTimesheetView(p.actor, { cutOff });
  if (!view?.timesheet.id) throw new Error('No timesheet.');
  return view.timesheet.id;
}

/** Submits and approves (supervisor, then HR) the employee's timesheet for `cutOff`. */
async function approve(p: Person, cutOff = CUT_OFF): Promise<string> {
  const { approvalRequestId, timesheetId } = await submitTimesheet(p.actor, {
    timesheetId: await timesheetOf(p, cutOff),
  });
  await decide(boss.actor, approvalRequestId, 'approve');
  await decide(hr.actor, approvalRequestId, 'approve');
  return timesheetId;
}

async function entriesOf(timesheetId: string) {
  return database()
    .collection('offsetEntries')
    .find({ timesheetId: new Types.ObjectId(timesheetId) })
    .sort({ _id: 1 })
    .toArray();
}

describe('the holidays-changed listener (D14)', () => {
  it('adjusts an approved timesheet’s credit when a holiday is confirmed, then deleted', async () => {
    registerTalentHolidaysChangedListener();
    registerTalentHolidaysChangedListener();
    const holidayId = await holiday('2026-11-30', { status: 'draft', name: 'Made-up Day' });

    const p = await employee();
    await marked(p, '2026-11-30', '08:00', '17:00');
    const timesheetId = await approve(p);
    expect((await entriesOf(timesheetId)).map((e) => [e.kind, e.minutes])).toEqual([['credit', 0]]);

    // A pending timesheet with the same day needs nothing: its DTR is read fresh.
    const pending = await employee();
    await marked(pending, '2026-11-30', '08:00', '17:00');
    const pendingId = (
      await submitTimesheet(pending.actor, { timesheetId: await timesheetOf(pending) })
    ).timesheetId;

    await setHoliday(holidayId, { status: 'confirmed' });
    const run = await runHolidaysChangedListeners({ dates: ['2026-11-30'] });
    expect(run.listeners).toBeGreaterThanOrEqual(1);
    expect((await entriesOf(timesheetId)).map((e) => [e.kind, e.minutes])).toEqual([
      ['credit', 0],
      ['adjustment', 480],
    ]);
    expect((await getOffsetBalance(p.actor, p.employeeId))?.balanceMinutes).toBe(480);
    expect(await entriesOf(pendingId)).toHaveLength(0);

    // Idempotent: a second run finds no difference.
    expect(await reconcileOffsetCredits(['2026-11-30'])).toMatchObject({ adjusted: 0 });
    expect(await entriesOf(timesheetId)).toHaveLength(2);

    const told = await notifications({
      event: OFFSET_ADJUSTED_EVENT,
      recipientUserId: new Types.ObjectId(p.userId),
    });
    expect(told).toHaveLength(1);
    expect(told[0]).toMatchObject({
      title: 'Your offset balance changed by +8.0 h: the holidays on Nov 30 changed',
      href: `/talent/timesheets/${p.employeeId}?cutOff=${CUT_OFF}`,
    });
    const [adjustment] = (await entriesOf(timesheetId)).filter((e) => e.kind === 'adjustment');
    expect(adjustment?.reason).toBe('Holiday changed: 2026-11-30');
    const audit = (await auditEntries(OFFSET_ENTRY_TYPE)).find(
      (row) => row.record.id.toHexString() === adjustment?._id.toHexString(),
    );
    expect(audit).toMatchObject({ action: 'create', actorId: null });

    // The DTR reads the holiday now; the day is final on the approved timesheet.
    const dtr = await getDtr(p.actor, p.employeeId, '2026-11-26', '2026-12-10');
    const day = dtr?.periods[0]?.days.find((d) => d.date === '2026-11-30');
    expect(day).toMatchObject({ status: 'holiday', final: true });

    await setHoliday(holidayId, { deleted: true });
    await reconcileOffsetCredits(['2026-11-30']);
    expect((await entriesOf(timesheetId)).map((e) => [e.kind, e.minutes])).toEqual([
      ['credit', 0],
      ['adjustment', 480],
      ['adjustment', -480],
    ]);
    expect((await getOffsetBalance(p.actor, p.employeeId))?.balanceMinutes).toBe(0);
  });

  it('registers as talent.recomputeDtr', () => {
    expect(RECOMPUTE_DTR_LISTENER).toBe('talent.recomputeDtr');
  });
});

describe('offset entries', () => {
  it('are insert-only', async () => {
    const created = await OffsetEntryModel.create({
      employeeId: new Types.ObjectId(),
      kind: 'adjustment',
      minutes: 5,
      effectiveOn: new Date('2026-12-11T00:00:00+08:00'),
      timesheetId: new Types.ObjectId(),
    });
    await expect(
      OffsetEntryModel.updateOne({ _id: created._id }, { $set: { minutes: 6 } }),
    ).rejects.toThrow();
    await expect(OffsetEntryModel.deleteOne({ _id: created._id })).rejects.toThrow();
    await expect(
      OffsetEntryModel.create({
        employeeId: new Types.ObjectId(),
        kind: 'credit',
        minutes: 1.5,
        effectiveOn: new Date(),
      }),
    ).rejects.toThrow();
  });

  it('sums the balance, and only whoever sees the timesheet reads it', async () => {
    const p = await employee();
    await marked(p, '2026-12-01', '08:00', '19:00');
    await approve(p);
    expect(await getOffsetBalance(p.actor, p.employeeId)).toEqual({
      employeeId: p.employeeId,
      balanceMinutes: 120,
      // Step 2.8: no pending offset time off holds any of it.
      pendingMinutes: 0,
      availableMinutes: 120,
    });
    expect((await getOffsetBalance(boss.actor, p.employeeId))?.balanceMinutes).toBe(120);
    expect((await getOffsetBalance(hr.actor, p.employeeId))?.balanceMinutes).toBe(120);
    await expect(getOffsetBalance(outsider.actor, p.employeeId)).rejects.toBeInstanceOf(
      AccessDeniedError,
    );
    expect(await getOffsetBalance(hr.actor, new Types.ObjectId().toHexString())).toBeNull();
  });
});

describe('getDtr', () => {
  it('reads a preview under the timesheet’s viewing rule, up to 93 days', async () => {
    const p = await employee();
    await marked(p, '2026-12-01', '08:16', '17:00');
    const dtr = await getDtr(p.actor, p.employeeId, '2026-11-26', '2026-12-10');
    expect(dtr?.periods).toHaveLength(1);
    const day = dtr?.periods[0]?.days.find((d) => d.date === '2026-12-01');
    expect(day).toMatchObject({ status: 'present', lateMinutes: 16, final: false });
    expect(dtr?.periods[0]?.days.find((d) => d.date === '2026-12-02')?.status).toBe('absentUnpaid');
    const across = await getDtr(boss.actor, p.employeeId, '2026-11-20', '2026-12-05');
    expect(across?.periods.map((period) => [period.from, period.to])).toEqual([
      ['2026-11-20', '2026-11-25'],
      ['2026-11-26', '2026-12-05'],
    ]);
    await expect(
      getDtr(outsider.actor, p.employeeId, '2026-11-26', '2026-12-10'),
    ).rejects.toBeInstanceOf(AccessDeniedError);
    await expect(getDtr(p.actor, p.employeeId, '2026-09-01', '2026-12-10')).rejects.toBeInstanceOf(
      ActionError,
    );
    await expect(getDtr(p.actor, p.employeeId, '2026-12-10', '2026-12-01')).rejects.toBeInstanceOf(
      ActionError,
    );
  });
});

describe('an Overtime timesheet treated as offset', () => {
  it('earns a credit when the setting treats Overtime extra hours as offset', async () => {
    await addConfigVersion(TIMESHEET_SETTINGS_SETTING, {
      effectiveFrom: '2027-01-11',
      value: { offsetRatio: '1', extraHours: { overtime: 'offset', standard: 'offset' } },
      source: 'Made-up test policy',
      actorId: null,
    });
    vi.setSystemTime(new Date('2027-01-26T10:00:00+08:00'));
    const p = await employee(NET);
    await marked(p, '2027-01-12', '08:00', '19:00');
    const timesheetId = await approve(p, '2027-01-11');
    expect((await entriesOf(timesheetId)).map((e) => [e.kind, e.minutes])).toEqual([
      ['credit', 120],
    ]);
  });
});
