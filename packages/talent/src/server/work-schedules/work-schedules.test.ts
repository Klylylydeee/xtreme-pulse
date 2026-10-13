import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Types } from 'mongoose';
import { connectDb } from '@pulse/db';
import { AccessDeniedError, ActionError } from '@pulse/core';
import { WORK_SCHEDULE_ASSIGNMENT_TYPE } from '../../timesheets/views';
import {
  auditEntries,
  type Department,
  department,
  type Person,
  person,
  seedPayrollSettings,
  setDateHired,
  setReportingTo,
} from '../testing/fixtures';
import { WorkScheduleAssignmentModel } from './model';
import { getWorkScheduleSection, setWorkSchedule } from './service';

// The work schedule assignment tests (docs/TESTING.md#timesheet-and-work-schedule-tests, build
// step 2.4, decision 215 in docs/BUILD_PLAN.md): who sets one, the date limits, insert-only
// entries with their audit entry, and who sees the section. Made-up people only.

let NET: Department;
let HRD: Department;
let hr: Person;
let hrReader: Person;
let hr2: Person;
let admin: Person;
let writer: Person;
let reader: Person;
let staff: Person;
let boss: Person;
let outsider: Person;

const OWN = {
  workDays: [1, 2, 3, 4, 5],
  start: '10:00',
  end: '19:00',
  breakStart: '14:00',
  breakMinutes: 60,
  graceMinutes: 15,
};

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-09-14T10:00:00+08:00'));
});

afterEach(() => {
  vi.useRealTimers();
});

beforeAll(async () => {
  await connectDb();
  await WorkScheduleAssignmentModel.init();
  await seedPayrollSettings();
  NET = await department('Network', 'NET');
  HRD = await department('Human Resource', 'HR');
  hr = await person('Hana', 'Reyes', HRD, { talent: 'write' });
  hrReader = await person('Hugo', 'Ramos', HRD, { talent: 'read' });
  hr2 = await person('Hilda', 'Santos', HRD, { talent: 'write' });
  admin = await person('Ada', 'Admin', NET, { admin: true });
  writer = await person('Wally', 'Cruz', NET, { talent: 'write' });
  reader = await person('Rita', 'Lopez', NET, { talent: 'read' });
  staff = await person('Sam', 'Diaz', NET, { dateHired: '2025-03-01' });
  boss = await person('Bea', 'Tan', NET);
  outsider = await person('Otto', 'Gomez', NET);
  await setReportingTo(staff, [boss]);
});

const set = (
  actor: Person,
  subject: Person,
  effectiveFrom: string,
  schedule: typeof OWN | null = OWN,
  reason = 'Client site hours',
) =>
  setWorkSchedule(actor.actor, { employeeId: subject.employeeId, effectiveFrom, schedule, reason });

describe('the Work schedule section', () => {
  it('shows the company default with no assignment', async () => {
    const section = await getWorkScheduleSection(staff.actor, staff.employeeId);
    expect(section?.current.origin).toBe('company');
    expect(section?.current.schedule).toMatchObject({ start: '08:00', end: '17:00' });
    expect(section?.currentScheduledMinutes).toBe(480);
    expect(section?.history).toEqual([]);
    expect(section?.canSet).toBe(false);
  });

  it('is open to the employee, Talent Read and a supervisor, and refused to anyone else', async () => {
    await expect(getWorkScheduleSection(reader.actor, staff.employeeId)).resolves.not.toBeNull();
    const supervisorView = await getWorkScheduleSection(boss.actor, staff.employeeId);
    expect(supervisorView).not.toBeNull();
    expect(supervisorView?.canSet).toBe(false);
    expect(supervisorView).not.toHaveProperty('earliestEffectiveFrom');
    await expect(getWorkScheduleSection(outsider.actor, staff.employeeId)).rejects.toBeInstanceOf(
      AccessDeniedError,
    );
  });

  it('offers "Set schedule" with its limits to HR with Talent Write', async () => {
    const section = await getWorkScheduleSection(hr.actor, staff.employeeId);
    expect(section?.canSet).toBe(true);
    expect(section?.earliestEffectiveFrom).toBe('2025-03-01');
    expect(section?.latestEffectiveFrom).toBe('2027-09-14');
  });
});

describe('setting a schedule', () => {
  it('lets HR with Talent Write set one, in one transaction with its create audit entry', async () => {
    const { id } = await set(hr, staff, '2026-09-16');
    const section = await getWorkScheduleSection(staff.actor, staff.employeeId);
    expect(section?.current.origin).toBe('company');
    expect(section?.scheduled.map((entry) => entry.id)).toEqual([id]);

    const audits = await auditEntries(WORK_SCHEDULE_ASSIGNMENT_TYPE);
    const audit = audits.find((entry) => String(entry.record.id) === id);
    expect(audit?.action).toBe('create');
    expect(audit?.record.label).toBe(`${staff.employeeNumber} · 2026-09-16`);
    expect(audit?.reason).toBe('Client site hours');

    vi.setSystemTime(new Date('2026-09-16T10:00:00+08:00'));
    const later = await getWorkScheduleSection(staff.actor, staff.employeeId);
    expect(later?.current).toMatchObject({ origin: 'own', effectiveFrom: '2026-09-16' });
    expect(later?.current.schedule.start).toBe('10:00');
  });

  it('lets the System Administrator set one, and HR set HR staff’s', async () => {
    await expect(set(admin, staff, '2026-10-01')).resolves.toHaveProperty('id');
    await expect(set(hr, hr2, '2026-10-01')).resolves.toHaveProperty('id');
  });

  it('refuses Talent Write alone, HR without Talent Write, and one’s own record', async () => {
    await expect(set(writer, staff, '2026-10-01')).rejects.toBeInstanceOf(AccessDeniedError);
    await expect(set(hrReader, staff, '2026-10-01')).rejects.toBeInstanceOf(AccessDeniedError);
    await expect(set(hr, hr, '2026-10-01')).rejects.toBeInstanceOf(AccessDeniedError);
    await expect(set(admin, admin, '2026-10-01')).rejects.toBeInstanceOf(AccessDeniedError);
  });

  it('refuses a date before the date hired or more than a year ahead', async () => {
    await expect(set(hr, staff, '2025-02-28')).rejects.toThrow(
      'The effective date can’t be before the date hired.',
    );
    await expect(set(hr, staff, '2027-09-15')).rejects.toThrow(
      'The effective date can be at most a year from today.',
    );
    await expect(set(hr, staff, '2027-09-14')).resolves.toHaveProperty('id');
  });

  it('uses the date hired as it is now', async () => {
    const late = await person('Lia', 'Late', NET, { dateHired: '2026-01-01' });
    await setDateHired(late, '2026-10-01');
    await expect(set(hr, late, '2026-09-20')).rejects.toBeInstanceOf(ActionError);
  });

  it('refuses invalid schedules: no work days, a break outside the span, under 60 minutes', async () => {
    await expect(set(hr, staff, '2026-10-01', { ...OWN, workDays: [] })).rejects.toBeInstanceOf(
      ActionError,
    );
    await expect(
      set(hr, staff, '2026-10-01', { ...OWN, breakStart: '18:30', breakMinutes: 60 }),
    ).rejects.toThrow('The break must fall inside the schedule');
    await expect(
      set(hr, staff, '2026-10-01', {
        ...OWN,
        start: '08:00',
        end: '09:00',
        breakMinutes: 30,
        breakStart: '08:15',
      }),
    ).rejects.toThrow('1 to 24 hours');
  });

  it('accepts an overnight schedule (an end before the start)', async () => {
    await expect(
      set(hr, staff, '2026-10-02', {
        ...OWN,
        start: '22:00',
        end: '07:00',
        breakStart: '02:00',
      }),
    ).resolves.toHaveProperty('id');
  });

  it('requires a reason', async () => {
    await expect(set(hr, staff, '2026-10-01', OWN, '   ')).rejects.toThrow(
      'Enter the reason for this schedule.',
    );
  });

  it('returns to the company default with a null schedule, the newest winning a tie', async () => {
    const subject = await person('Nina', 'Null', NET, { dateHired: '2025-01-01' });
    await set(hr, subject, '2026-09-01');
    await set(hr, subject, '2026-09-10', null);
    let section = await getWorkScheduleSection(subject.actor, subject.employeeId);
    expect(section?.current.origin).toBe('company');
    await set(hr, subject, '2026-09-10', {
      ...OWN,
      start: '07:00',
      end: '16:00',
      breakStart: '11:00',
    });
    section = await getWorkScheduleSection(subject.actor, subject.employeeId);
    expect(section?.current).toMatchObject({ origin: 'own', effectiveFrom: '2026-09-10' });
    expect(section?.current.schedule.start).toBe('07:00');
    expect(section?.history).toHaveLength(3);
  });

  it('is insert-only: entries are never changed or deleted', async () => {
    const { id } = await set(hr, staff, '2026-11-02');
    const _id = new Types.ObjectId(id);
    await expect(
      WorkScheduleAssignmentModel.updateOne({ _id }, { $set: { reason: 'changed' } }),
    ).rejects.toThrow('never changed or deleted');
    await expect(WorkScheduleAssignmentModel.deleteOne({ _id })).rejects.toThrow(
      'never changed or deleted',
    );
    const loaded = await WorkScheduleAssignmentModel.findById(_id);
    if (!loaded) throw new Error('The assignment was not saved.');
    loaded.reason = 'changed';
    await expect(loaded.save()).rejects.toThrow('never changed or deleted');
  });
});
