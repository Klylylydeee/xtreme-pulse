import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Types } from 'mongoose';
import { connectDb } from '@pulse/db';
import { AccessDeniedError, ActionError } from '@pulse/core';
import { STALE_ENTRY_MESSAGE, TIME_ENTRY_TYPE } from '../../timesheets/views';
import {
  auditEntries,
  client,
  database,
  type Department,
  department,
  type Person,
  person,
  seedPayrollSettings,
  separate,
  setPositionType,
  setReportingTo,
  setSeparationDate,
  systemAccount,
} from '../testing/fixtures';
import { TimeEntryModel, TimesheetModel } from './model';
import { OPEN_TIMESHEETS_JOB, OPEN_TIMESHEETS_SCHEDULE, runOpenTimesheets } from './open-job';
import {
  ALREADY_TIMED_IN,
  createTimeEntry,
  deleteTimeEntry,
  ENTRY_NOT_FOUND,
  getOwnTimesheetView,
  getTimesheetView,
  listMyTeam,
  timeIn,
  timeOut,
  updateTimeEntry,
} from './service';

// The timesheet tests (docs/TESTING.md#timesheet-and-work-schedule-tests, build step 2.4,
// decisions 217–222 in docs/BUILD_PLAN.md): the opening job and the type snapshot, the clock and
// manual times, every refusal, the version check, soft delete with its audit entry, and who may
// see and change a timesheet. Made-up people only. "Today" is Monday 2026-09-14, 10:00 Manila,
// in the cut-off 2026-09-11 to 2026-09-25, unless a test says otherwise.

let NET: Department;
let OFF: Department;
let HRD: Department;
let hr: Person;
let admin: Person;
let reader: Person;
let boss: Person;
let outsider: Person;
let worker: Person;
let clientId: string;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-09-14T10:00:00+08:00'));
});

afterEach(() => {
  vi.useRealTimers();
});

beforeAll(async () => {
  await connectDb();
  await TimesheetModel.init();
  await TimeEntryModel.init();
  await seedPayrollSettings();
  NET = await department('Network', 'NET');
  OFF = await department('Office', 'OFF');
  await setPositionType(OFF, 'standard');
  HRD = await department('Human Resource', 'HR');
  hr = await person('Hana', 'Reyes', HRD, { talent: 'write' });
  admin = await person('Ada', 'Admin', NET, { admin: true });
  reader = await person('Rita', 'Lopez', NET, { talent: 'read' });
  boss = await person('Bea', 'Tan', NET);
  outsider = await person('Otto', 'Gomez', NET);
  worker = await person('Wes', 'Lim', NET, { dateHired: '2025-01-01' });
  await setReportingTo(worker, [boss]);
  clientId = await client('Made-up Client Corp');
});

/** A new employee of `dept` (Network, Overtime timesheet, by default). */
let count = 0;
async function employee(dept: Department = NET, dateHired = '2025-01-01'): Promise<Person> {
  count += 1;
  return person('Test', `Person${count}`, dept, { dateHired });
}

const entry = (
  p: Person,
  values: {
    date: string;
    timeIn: string;
    timeOut: string | null;
    timeOutNextDay?: boolean;
    activity?: string | null;
    clientId?: string | null;
    extraHoursReason?: string | null;
  },
) =>
  createTimeEntry(p.actor, {
    activity: 'Site survey',
    clientId: null,
    extraHoursReason: null,
    ...values,
  });

async function storedEntry(id: string) {
  return database()
    .collection('timeEntries')
    .findOne({ _id: new Types.ObjectId(id) });
}

describe('the opening job', () => {
  it('is defined for the worker with cron 5 0 * * *', () => {
    expect(OPEN_TIMESHEETS_JOB.name).toBe('talent.openTimesheets');
    expect(OPEN_TIMESHEETS_SCHEDULE).toMatchObject({
      id: 'talent.openTimesheets',
      pattern: '5 0 * * *',
    });
  });

  it('creates one timesheet per active employee for today’s cut-off, and nothing on a second run', async () => {
    vi.setSystemTime(new Date('2026-09-14T00:05:00+08:00'));
    const gone = await employee();
    await separate(gone);
    const future = await employee(NET, '2026-10-01');

    const first = await runOpenTimesheets();
    expect(first.periodStart).toBe('2026-09-11');
    expect(first.periodEnd).toBe('2026-09-25');
    expect(first.created).toBeGreaterThan(0);

    const second = await runOpenTimesheets();
    expect(second.created).toBe(0);
    expect(second.existing).toBe(first.created + first.existing);

    const sheets = database().collection('timesheets');
    expect(await sheets.countDocuments({ employeeId: new Types.ObjectId(worker.employeeId) })).toBe(
      1,
    );
    expect(await sheets.countDocuments({ employeeId: new Types.ObjectId(gone.employeeId) })).toBe(
      0,
    );
    expect(await sheets.countDocuments({ employeeId: new Types.ObjectId(future.employeeId) })).toBe(
      0,
    );
    const stored = await sheets.findOne({ employeeId: new Types.ObjectId(worker.employeeId) });
    expect(stored).toMatchObject({ timesheetType: 'overtime', status: 'open' });
    expect(stored?.typeReadOn).toEqual(new Date('2026-09-14T00:00:00+08:00'));
  });

  it('keeps the type for the cut-off; the next cut-off takes the new one', async () => {
    const DRV = await department('Drivers', 'DRV');
    const driver = await employee(DRV);
    vi.setSystemTime(new Date('2026-09-11T00:05:00+08:00'));
    await runOpenTimesheets();

    await setPositionType(DRV, 'standard');
    vi.setSystemTime(new Date('2026-09-14T10:00:00+08:00'));
    await runOpenTimesheets();
    const view = await getOwnTimesheetView(driver.actor);
    expect(view?.timesheet).toMatchObject({
      periodStart: '2026-09-11',
      timesheetType: 'overtime',
      typeReadOn: '2026-09-11',
    });
    expect(view?.treatment).toBe('overtime');

    vi.setSystemTime(new Date('2026-09-26T00:05:00+08:00'));
    await runOpenTimesheets();
    const next = await getOwnTimesheetView(driver.actor);
    expect(next?.timesheet).toMatchObject({
      periodStart: '2026-09-26',
      timesheetType: 'standard',
      typeReadOn: '2026-09-26',
    });
    expect(next?.treatment).toBe('offset');
    const previous = await getOwnTimesheetView(driver.actor, { cutOff: '2026-09-11' });
    expect(previous?.timesheet.timesheetType).toBe('overtime');
  });

  it('creates a timesheet on first use with that day’s type', async () => {
    const hire = await employee(OFF);
    await timeIn(hire.actor);
    const sheets = await TimesheetModel.find({
      employeeId: new Types.ObjectId(hire.employeeId),
    }).lean();
    expect(sheets).toHaveLength(1);
    expect(sheets[0]).toMatchObject({ timesheetType: 'standard' });
    expect(sheets[0]?.typeReadOn).toEqual(new Date('2026-09-14T00:00:00+08:00'));
  });

  it('never changes a timesheet’s type', async () => {
    const sheet = await TimesheetModel.findOne({
      employeeId: new Types.ObjectId(worker.employeeId),
    });
    await expect(
      TimesheetModel.updateOne({ _id: sheet?._id }, { $set: { timesheetType: 'standard' } }),
    ).rejects.toThrow('never changed');
    await expect(TimesheetModel.deleteOne({ _id: sheet?._id })).rejects.toThrow('never changed');
    // Only the save's touch is allowed: updatedBy, updatedAt and the `__v` increment.
    await expect(
      TimesheetModel.updateOne({ _id: sheet?._id }, { $inc: { __v: 1 } }),
    ).resolves.toBeTruthy();
    await expect(
      TimesheetModel.updateOne({ _id: sheet?._id }, { $inc: { status: 1 } }),
    ).rejects.toThrow('never changed');
  });
});

describe('the clock', () => {
  it('Time in stores the server’s time as clock; a second Time in is refused', async () => {
    const p = await employee();
    const result = await timeIn(p.actor);
    expect(result.timeIn).toEqual(new Date('2026-09-14T10:00:00+08:00'));
    const stored = await storedEntry(result.entryId);
    expect(stored).toMatchObject({ timeInSource: 'clock', timeOut: null, timeOutSource: null });
    expect(stored?.date).toEqual(new Date('2026-09-14T00:00:00+08:00'));
    await expect(timeIn(p.actor)).rejects.toThrow(ALREADY_TIMED_IN);
  });

  it('Time out asks for the activity first, then stores the server’s time as clock', async () => {
    const p = await employee();
    const { entryId } = await timeIn(p.actor);
    vi.setSystemTime(new Date('2026-09-14T12:30:00+08:00'));
    const asked = await timeOut(p.actor);
    expect(asked).toEqual({ status: 'activityRequired', entryId, version: 1 });
    expect((await storedEntry(entryId))?.timeOut).toBeNull();

    const done = await timeOut(p.actor, { activity: 'Rack install', clientId });
    expect(done).toMatchObject({ status: 'timedOut', entryId, version: 2 });
    const stored = await storedEntry(entryId);
    expect(stored).toMatchObject({
      timeOutSource: 'clock',
      activity: 'Rack install',
      version: 2,
    });
    expect(stored?.timeOut).toEqual(new Date('2026-09-14T12:30:00+08:00'));
    await expect(timeOut(p.actor)).rejects.toThrow('You aren’t timed in.');
  });

  it('editing a clocked time sets that side to manual; an unchanged one stays clock', async () => {
    const p = await employee();
    const { entryId } = await timeIn(p.actor);
    vi.setSystemTime(new Date('2026-09-14T11:00:00+08:00'));
    await timeOut(p.actor, { activity: 'Cabling' });
    await updateTimeEntry(p.actor, {
      entryId,
      version: 2,
      date: '2026-09-14',
      timeIn: '10:00',
      timeOut: '10:45',
      activity: 'Cabling',
      clientId: null,
      extraHoursReason: null,
    });
    let stored = await storedEntry(entryId);
    expect(stored).toMatchObject({ timeInSource: 'clock', timeOutSource: 'manual', version: 3 });

    // A browser can't save a time as clock: an extra source field is ignored.
    await updateTimeEntry(p.actor, {
      entryId,
      version: 3,
      date: '2026-09-14',
      timeIn: '09:55',
      timeOut: '10:45',
      activity: 'Cabling',
      clientId: null,
      extraHoursReason: null,
      timeInSource: 'clock',
    } as never);
    stored = await storedEntry(entryId);
    expect(stored).toMatchObject({ timeInSource: 'manual', timeOutSource: 'manual' });
    expect(stored?.timeIn).toEqual(new Date('2026-09-14T09:55:00+08:00'));
  });
});

describe('manual entries', () => {
  it('saves typed times as manual, with the hours computed for the view (case 1)', async () => {
    const p = await employee();
    const { id } = await entry(p, {
      date: '2026-09-11',
      timeIn: '08:00',
      timeOut: '19:00',
      clientId,
      extraHoursReason: 'Urgent cutover',
    });
    const stored = await storedEntry(id);
    expect(stored).toMatchObject({ timeInSource: 'manual', timeOutSource: 'manual', version: 1 });

    const view = await getOwnTimesheetView(p.actor);
    const day = view?.days.find((d) => d.hours.date === '2026-09-11');
    expect(day?.hours.workedMinutes).toBe(600);
    expect(day?.hours.overtime.ordinaryMinutes).toBe(120);
    expect(day?.hours.nightDifferentialMinutes).toBe(0);
    expect(day?.entries[0]).toMatchObject({
      id,
      timeInSource: 'manual',
      client: { id: clientId, name: 'Made-up Client Corp' },
      extraHours: { reason: 'Urgent cutover' },
      endsNextDay: false,
    });
    expect(day?.hours).not.toHaveProperty('entries');
    expect(view?.totals.totalOvertimeMinutes).toBe(120);
    expect(view?.own).toBe(true);
    expect(view?.clients?.some((c) => c.id === clientId)).toBe(true);
  });

  it('shows offset on a Standard timesheet (case 10)', async () => {
    vi.setSystemTime(new Date('2026-09-14T20:00:00+08:00'));
    const p = await employee(OFF);
    await entry(p, {
      date: '2026-09-14',
      timeIn: '07:55',
      timeOut: '19:30',
      extraHoursReason: 'Month-end close',
    });
    const view = await getOwnTimesheetView(p.actor);
    expect(view?.treatment).toBe('offset');
    expect(view?.totals.workedMinutes).toBe(635);
    expect(view?.offset).toEqual({ balanceMinutes: 0, thisCutOffMinutes: 155, credited: null });
    expect(view?.todayCard?.workedMinutes).toBe(635);
  });

  it('keeps an entry past midnight on its time-in day', async () => {
    const p = await employee();
    const { id } = await entry(p, {
      date: '2026-09-13',
      timeIn: '20:00',
      timeOut: '02:00',
      timeOutNextDay: true,
      extraHoursReason: 'Night maintenance',
    });
    const view = await getOwnTimesheetView(p.actor);
    const day = view?.days.find((d) => d.hours.date === '2026-09-13');
    expect(day?.entries[0]).toMatchObject({ id, endsNextDay: true });
    expect(day?.hours.overtime.restDayMinutes).toBe(360);
    expect(day?.hours.nightDifferentialMinutes).toBe(240);
  });

  it('refuses each broken rule', async () => {
    const p = await employee(NET, '2026-09-12');
    await entry(p, { date: '2026-09-12', timeIn: '22:00', timeOut: '02:00', timeOutNextDay: true });
    await entry(p, { date: '2026-09-14', timeIn: '08:00', timeOut: '09:00' });

    const refused = async (values: Parameters<typeof entry>[1], message: string) => {
      await expect(entry(p, values)).rejects.toThrow(message);
    };
    await refused(
      { date: '2026-09-12', timeIn: '10:00', timeOut: '09:00' },
      'The time out must be after the time in.',
    );
    await refused(
      { date: '2026-09-12', timeIn: '08:00', timeOut: '09:00', timeOutNextDay: true },
      'An entry can last at most 24 hours.',
    );
    await refused(
      { date: '2026-09-14', timeIn: '09:30', timeOut: '11:00' },
      'The time out can’t be in the future.',
    );
    await refused(
      { date: '2026-09-14', timeIn: '10:30', timeOut: null },
      'The time in can’t be in the future.',
    );
    await refused(
      { date: '2026-09-15', timeIn: '08:00', timeOut: '09:00' },
      'The date can’t be after today.',
    );
    await refused(
      { date: '2026-09-11', timeIn: '08:00', timeOut: '09:00' },
      'The date can’t be before your date hired.',
    );
    // The same day, and an entry of the previous day running past midnight.
    await refused(
      { date: '2026-09-14', timeIn: '08:30', timeOut: '09:30' },
      'This entry overlaps another entry on Sep 14, 2026.',
    );
    await refused(
      { date: '2026-09-13', timeIn: '01:00', timeOut: '03:00' },
      'This entry overlaps another entry on Sep 12, 2026.',
    );
    await refused(
      { date: '2026-09-13', timeIn: '08:00', timeOut: '09:00', activity: 'x'.repeat(501) },
      'Use at most 500 characters.',
    );
    await refused(
      { date: '2026-09-13', timeIn: '08:00', timeOut: '09:00', activity: '  ' },
      'Enter the activity performed.',
    );
    // Touching ends are fine.
    await expect(
      entry(p, { date: '2026-09-13', timeIn: '02:00', timeOut: '03:00' }),
    ).resolves.toHaveProperty('id');
  });

  it('refuses a date after the separation date', async () => {
    const p = await employee();
    await setSeparationDate(p, '2026-09-12');
    await expect(
      entry(p, { date: '2026-09-13', timeIn: '08:00', timeOut: '09:00' }),
    ).rejects.toThrow('The date can’t be after your separation date.');
    await expect(
      entry(p, { date: '2026-09-12', timeIn: '08:00', timeOut: '09:00' }),
    ).resolves.toHaveProperty('id');
  });

  it('refuses an overlap with the open entry, and a second open entry', async () => {
    const p = await employee();
    vi.setSystemTime(new Date('2026-09-14T08:00:00+08:00'));
    await timeIn(p.actor);
    vi.setSystemTime(new Date('2026-09-14T10:00:00+08:00'));
    await expect(
      entry(p, { date: '2026-09-14', timeIn: '09:00', timeOut: '09:30' }),
    ).rejects.toThrow('overlaps your open entry');
    await expect(entry(p, { date: '2026-09-13', timeIn: '09:00', timeOut: null })).rejects.toThrow(
      ALREADY_TIMED_IN,
    );
    await expect(
      entry(p, { date: '2026-09-14', timeIn: '07:00', timeOut: '07:30' }),
    ).resolves.toHaveProperty('id');
  });

  it('compares entries in whole minutes: a typed entry may start in the minute a clocked one ended', async () => {
    const p = await employee();
    vi.setSystemTime(new Date('2026-09-14T08:00:20+08:00'));
    await timeIn(p.actor);
    vi.setSystemTime(new Date('2026-09-14T09:00:42+08:00'));
    await timeOut(p.actor, { activity: 'Cabling' });
    vi.setSystemTime(new Date('2026-09-14T10:00:00+08:00'));
    // 09:00:42 drops to 09:00, so 09:00–09:30 touches the clocked entry.
    await expect(
      entry(p, { date: '2026-09-14', timeIn: '09:00', timeOut: '09:30' }),
    ).resolves.toHaveProperty('id');
    // And 07:30–08:00 touches its 08:00:20 start.
    await expect(
      entry(p, { date: '2026-09-14', timeIn: '07:30', timeOut: '08:00' }),
    ).resolves.toHaveProperty('id');
    await expect(
      entry(p, { date: '2026-09-14', timeIn: '08:59', timeOut: '09:10' }),
    ).rejects.toThrow('overlaps another entry');
    const view = await getOwnTimesheetView(p.actor);
    const day = view?.days.find((d) => d.hours.date === '2026-09-14');
    expect(day?.hours.workedMinutes).toBe(30 + 60 + 30);
  });

  it('serializes two saves at once: overlapping entries never both save', async () => {
    const p = await employee();
    // The timesheet exists, so each save touches it and the second transaction retries.
    await entry(p, { date: '2026-09-11', timeIn: '06:00', timeOut: '07:00' });
    for (let round = 0; round < 3; round += 1) {
      const results = await Promise.allSettled([
        entry(p, { date: '2026-09-12', timeIn: `0${round + 1}:00`, timeOut: `0${round + 1}:30` }),
        entry(p, { date: '2026-09-12', timeIn: `0${round + 1}:15`, timeOut: `0${round + 1}:45` }),
      ]);
      expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
      const refused = results.find((result) => result.status === 'rejected');
      expect(String(refused?.status === 'rejected' && refused.reason)).toContain('overlaps');
    }
  });

  it('refuses a stale version', async () => {
    const p = await employee();
    const { id } = await entry(p, { date: '2026-09-11', timeIn: '08:00', timeOut: '12:00' });
    const values = {
      entryId: id,
      date: '2026-09-11',
      timeIn: '08:00',
      timeOut: '12:30',
      activity: 'Site survey',
      clientId: null,
      extraHoursReason: null,
    };
    await updateTimeEntry(p.actor, { ...values, version: 1 });
    await expect(updateTimeEntry(p.actor, { ...values, version: 1 })).rejects.toThrow(
      STALE_ENTRY_MESSAGE,
    );
    await expect(deleteTimeEntry(p.actor, { entryId: id, version: 1 })).rejects.toThrow(
      STALE_ENTRY_MESSAGE,
    );
  });

  it('soft deletes, and audits each create, update and delete in its transaction', async () => {
    const p = await employee();
    const { id } = await entry(p, { date: '2026-09-11', timeIn: '08:00', timeOut: '12:00' });
    await updateTimeEntry(p.actor, {
      entryId: id,
      version: 1,
      date: '2026-09-11',
      timeIn: '08:00',
      timeOut: '12:15',
      activity: 'Site survey, part 2',
      clientId: null,
      extraHoursReason: null,
    });
    await deleteTimeEntry(p.actor, { entryId: id, version: 2 });

    const stored = await storedEntry(id);
    expect(stored?.deletedAt).toBeInstanceOf(Date);
    expect(stored?.version).toBe(3);
    const view = await getOwnTimesheetView(p.actor);
    expect(view?.days.flatMap((d) => d.entries).some((e) => e.id === id)).toBe(false);

    const audits = (await auditEntries(TIME_ENTRY_TYPE)).filter(
      (audit) => String(audit.record.id) === id,
    );
    expect(audits.map((audit) => audit.action)).toEqual(['create', 'update', 'delete']);
    expect(audits.every((audit) => audit.record.label === `${p.employeeNumber} · 2026-09-11`)).toBe(
      true,
    );
    expect(audits.every((audit) => audit.actorId.toHexString() === p.userId)).toBe(true);
  });

  it('writes nothing when the save is refused', async () => {
    const p = await employee();
    const before = (await auditEntries(TIME_ENTRY_TYPE)).length;
    await expect(
      entry(p, { date: '2026-09-11', timeIn: '10:00', timeOut: '09:00' }),
    ).rejects.toBeInstanceOf(ActionError);
    expect((await auditEntries(TIME_ENTRY_TYPE)).length).toBe(before);
    expect(
      await TimeEntryModel.countDocuments({ employeeId: new Types.ObjectId(p.employeeId) }),
    ).toBe(0);
  });
});

describe('who sees and changes a timesheet', () => {
  let entryId: string;

  beforeAll(async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-14T10:00:00+08:00'));
    ({ id: entryId } = await entry(worker, {
      date: '2026-09-11',
      timeIn: '08:00',
      timeOut: '19:00',
      extraHoursReason: 'Cutover',
    }));
    vi.useRealTimers();
  });

  it('acts only on the actor’s own employee: an employee id in the request is ignored', async () => {
    const p = await employee();
    const { id } = await createTimeEntry(p.actor, {
      employeeId: worker.employeeId,
      date: '2026-09-11',
      timeIn: '06:00',
      timeOut: '07:00',
      activity: 'Prep',
      clientId: null,
      extraHoursReason: null,
    } as never);
    expect((await storedEntry(id))?.employeeId.toHexString()).toBe(p.employeeId);
  });

  it('refuses any change to another person’s entries, HR and the System Administrator included', async () => {
    const values = {
      entryId,
      version: 1,
      date: '2026-09-11',
      timeIn: '08:00',
      timeOut: '18:00',
      activity: 'Changed',
      clientId: null,
      extraHoursReason: null,
    };
    for (const actor of [hr, admin, reader, boss]) {
      await expect(updateTimeEntry(actor.actor, values)).rejects.toThrow(ENTRY_NOT_FOUND);
      await expect(deleteTimeEntry(actor.actor, { entryId, version: 1 })).rejects.toThrow(
        ENTRY_NOT_FOUND,
      );
    }
    expect(await storedEntry(entryId)).toMatchObject({ version: 1, activity: 'Site survey' });
  });

  it('opens it read-only for Talent Read and a supervisor with no module access', async () => {
    const forReader = await getTimesheetView(reader.actor, worker.employeeId);
    expect(forReader?.own).toBe(false);
    expect(forReader?.clients).toBeUndefined();
    expect(forReader?.days.flatMap((d) => d.entries).map((e) => e.id)).toContain(entryId);

    const forBoss = await getTimesheetView(boss.actor, worker.employeeId);
    expect(forBoss?.own).toBe(false);
    expect(forBoss?.employee).toEqual({
      id: worker.employeeId,
      name: 'Wes Lim',
      employeeNumber: worker.employeeNumber,
    });
    const json = JSON.stringify(forBoss);
    expect(json).not.toContain('dateHired');
    expect(json).not.toContain('employmentStatus');
    expect(json).not.toContain('separationDate');
    expect(json).not.toContain('2025-01-01');
  });

  it('refuses another employee who isn’t a supervisor and has no Talent Read', async () => {
    await expect(getTimesheetView(outsider.actor, worker.employeeId)).rejects.toBeInstanceOf(
      AccessDeniedError,
    );
    await expect(
      getTimesheetView(outsider.actor, new Types.ObjectId().toHexString()),
    ).rejects.toBeInstanceOf(AccessDeniedError);
  });

  it('lists My team for a supervisor, on their own timesheet too', async () => {
    const team = await listMyTeam(boss.actor);
    expect(team).toEqual([
      {
        employeeId: worker.employeeId,
        name: 'Wes Lim',
        employeeNumber: worker.employeeNumber,
        href: `/talent/timesheets/${worker.employeeId}`,
        // Step 2.7: the latest ended cut-off's status (no timesheet, past its deadline).
        status: {
          periodStart: '2026-08-26',
          periodEnd: '2026-09-10',
          status: null,
          label: 'Overdue',
          overdue: true,
          submittedLate: false,
        },
        // Step 2.8: their time off, read-only.
        timeOffHref: `/talent/time-off/${worker.employeeId}`,
      },
    ]);
    expect((await getOwnTimesheetView(boss.actor))?.myTeam).toEqual(team);
    expect(await listMyTeam(outsider.actor)).toEqual([]);
  });

  it('refuses the system account, which has no employee', async () => {
    const system = await systemAccount();
    await expect(getOwnTimesheetView(system)).rejects.toBeInstanceOf(AccessDeniedError);
    await expect(timeIn(system)).rejects.toBeInstanceOf(AccessDeniedError);
  });

  it('treats a cut-off out of range as not found', async () => {
    expect(await getOwnTimesheetView(worker.actor, { cutOff: '2026-09-12' })).toBeNull();
    expect(await getOwnTimesheetView(worker.actor, { cutOff: '2026-09-26' })).toBeNull();
    expect(await getOwnTimesheetView(worker.actor, { cutOff: '2024-12-11' })).toBeNull();
    expect(await getOwnTimesheetView(worker.actor, { cutOff: 'not-a-date' })).toBeNull();
    const previous = await getOwnTimesheetView(worker.actor, { cutOff: '2026-08-26' });
    expect(previous?.timesheet.periodEnd).toBe('2026-09-10');
    expect(previous?.nextCutOff).toBe('2026-09-11');
    expect(previous?.todayCard).toBeNull();
  });
});
