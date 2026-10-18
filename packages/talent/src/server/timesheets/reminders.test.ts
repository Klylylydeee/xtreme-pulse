import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { Types } from 'mongoose';
import { connectDb } from '@pulse/db';
import { AccessDeniedError } from '@pulse/core';
import { registerTalentApprovalTypes } from '../change-requests/service';
import { registerTalentApprovalSigner, uploadESignature } from '../e-signatures/service';
import {
  approvalRequest,
  decide,
  type Department,
  department,
  notifications,
  type Person,
  person,
  pngFile,
  seedPayrollSettings,
  separate,
  setReportingTo,
  setTimesheetStatus,
} from '../testing/fixtures';
import { getTimesheetsList } from './list';
import { TimeEntryModel, TimesheetModel } from './model';
import {
  runTimesheetReminders,
  TIMESHEET_DUE_EVENT,
  TIMESHEET_REMINDERS_JOB,
  TIMESHEET_REMINDERS_SCHEDULE,
  TIMESHEETS_MISSING_EVENT,
} from './reminders';
import { getOwnTimesheetView } from './service';
import { submitTimesheet } from './submission';

// The reminders and the timesheets list (docs/TESTING.md#timesheet-approval-dtr-and-offset-tests:
// "Reminders", "The timesheets list"; decisions 293 and 294 in docs/BUILD_PLAN.md). Made-up people
// only. The cut-off 2026-09-11 to 2026-09-25 opens for submission and is due on 2026-09-26 (the
// seeded deadline of 1 day); it is overdue on 2026-09-27. No HR user exists until a test adds one,
// so HR's reminder goes to the System Administrators first.

const CUT_OFF = '2026-09-11';

let storageDir: string;
let NET: Department;
let HRD: Department;
let admin: Person;
let reader: Person;
let outsider: Person;
let boss: Person;
let late: Person;
let submitted: Person;
let gone: Person;
let done: Person;

function at(iso: string): Date {
  const date = new Date(iso);
  vi.setSystemTime(date);
  return date;
}

afterEach(() => {
  vi.useRealTimers();
});

beforeAll(async () => {
  storageDir = await mkdtemp(path.join(tmpdir(), 'pulse-test-storage-'));
  process.env.FILE_STORAGE_DIR = storageDir;
  await connectDb();
  await Promise.all([TimesheetModel.init(), TimeEntryModel.init()]);
  await seedPayrollSettings();
  NET = await department('Network', 'NET');
  HRD = await department('Human Resource', 'HR');
  admin = await person('Ada', 'Admin', NET, { admin: true });
  reader = await person('Rita', 'Lopez', NET, { talent: 'read' });
  outsider = await person('Otto', 'Gomez', NET);
  boss = await person('Bea', 'Tan', NET);
  late = await person('Lea', 'Santos', NET, { dateHired: '2025-01-01' });
  submitted = await person('Sid', 'Reyes', NET, { dateHired: '2025-01-01' });
  gone = await person('Gio', 'Dela Cruz', NET, { dateHired: '2025-01-01' });
  done = await person('Dina', 'Uy', NET, { dateHired: '2025-01-01' });
  for (const approver of [admin, boss]) await uploadESignature(approver.actor, pngFile());
  registerTalentApprovalSigner();
  registerTalentApprovalTypes();

  vi.useFakeTimers({ toFake: ['Date'] });
  at('2026-09-14T10:00:00+08:00');
  const ids: Record<string, string> = {};
  for (const p of [late, submitted, gone, done]) {
    const view = await getOwnTimesheetView(p.actor);
    ids[p.employeeId] = view?.timesheet.id ?? '';
  }
  vi.useRealTimers();
  await setTimesheetStatus(ids[submitted.employeeId] ?? '', 'pendingSupervisor');
  await setTimesheetStatus(ids[done.employeeId] ?? '', 'approved');
  await separate(gone);
});

afterAll(async () => {
  await rm(storageDir, { recursive: true, force: true });
});

const dueFor = (p: Person) =>
  notifications({ event: TIMESHEET_DUE_EVENT, recipientUserId: new Types.ObjectId(p.userId) });
const missingFor = (p: Person) =>
  notifications({ event: TIMESHEETS_MISSING_EVENT, recipientUserId: new Types.ObjectId(p.userId) });

describe('the reminder job', () => {
  it('is defined for the worker with cron 0 8 * * *', () => {
    expect(TIMESHEET_REMINDERS_JOB.name).toBe('talent.timesheetReminders');
    expect(TIMESHEET_REMINDERS_SCHEDULE).toMatchObject({
      id: 'talent.timesheetReminders',
      pattern: '0 8 * * *',
    });
  });

  it('reminds the employee of an open timesheet on the deadline day, once', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const when = at('2026-09-26T08:00:00+08:00');
    await runTimesheetReminders(when);
    await runTimesheetReminders(when);
    const due = await dueFor(late);
    expect(due).toHaveLength(1);
    expect(due[0]).toMatchObject({
      title: 'Your timesheet for Sep 11 – 25 is ready to submit, due today',
      href: `/talent/timesheet?cutOff=${CUT_OFF}`,
    });
    for (const p of [submitted, gone, done]) expect(await dueFor(p)).toHaveLength(0);
    // HR hears nothing before the day after the deadline.
    expect(await missingFor(admin)).toHaveLength(0);
  });

  it('reminds again the day after (overdue), and tells the System Administrators when no HR user is active', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const when = at('2026-09-27T08:00:00+08:00');
    const result = await runTimesheetReminders(when);
    await runTimesheetReminders(when);
    const due = await dueFor(late);
    expect(due).toHaveLength(2);
    expect(due[1]?.title).toBe('Your timesheet for Sep 11 – 25 is overdue. Submit it now');
    const missing = await missingFor(admin);
    expect(missing).toHaveLength(1);
    expect(missing[0]).toMatchObject({
      href: `/talent/timesheets?cutOff=${CUT_OFF}&status=notSubmitted`,
    });
    // The separated employee's open timesheet isn't counted.
    expect(result.timesheets).toBe(2);
    expect(missing[0]?.title).toBe('1 timesheet not submitted for Sep 11 – 25');
  });

  it('says nothing after the reminder days, nor for a cut-off long past', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    await runTimesheetReminders(at('2026-09-28T08:00:00+08:00'));
    await runTimesheetReminders(at('2026-10-20T08:00:00+08:00'));
    expect(await dueFor(late)).toHaveLength(2);
    expect(await missingFor(admin)).toHaveLength(1);
  });
});

describe('the HR step for the only HR user', () => {
  it('goes to the System Administrators when the requester is the only active HR user', async () => {
    const solo = await person('Sol', 'Abad', HRD, { dateHired: '2025-01-01' });
    await setReportingTo(solo, [boss]);
    vi.useFakeTimers({ toFake: ['Date'] });
    at('2026-09-14T10:00:00+08:00');
    const view = await getOwnTimesheetView(solo.actor);
    at('2026-09-26T10:00:00+08:00');
    const { approvalRequestId } = await submitTimesheet(solo.actor, {
      timesheetId: view?.timesheet.id ?? '',
    });
    await decide(boss.actor, approvalRequestId, 'approve');
    const request = await approvalRequest(approvalRequestId);
    const hrStep = request?.steps[1];
    expect(hrStep?.routedToSystemAdministrator).toBe(true);
    const approverIds = (hrStep?.approvers ?? []).map((a: { userId: Types.ObjectId }) =>
      a.userId.toHexString(),
    );
    expect(approverIds).toContain(admin.userId);
    expect(approverIds).not.toContain(solo.userId);
  });
});

describe('HR’s reminder', () => {
  it('tells the active HR users, not the System Administrators, once there is one', async () => {
    const hrUser = await person('Hana', 'Reyes', HRD, { talent: 'write' });
    vi.useFakeTimers({ toFake: ['Date'] });
    at('2026-10-01T10:00:00+08:00');
    await getOwnTimesheetView(late.actor);
    // The cut-off 2026-09-26 to 2026-10-10 is due 2026-10-11.
    await runTimesheetReminders(at('2026-10-12T08:00:00+08:00'));
    const missing = await missingFor(hrUser);
    expect(missing).toHaveLength(1);
    expect(missing[0]?.href).toBe('/talent/timesheets?cutOff=2026-09-26&status=notSubmitted');
    expect(await missingFor(admin)).toHaveLength(1);
  });
});

describe('the timesheets list', () => {
  it('shows Talent Read the counts and rows of a cut-off, each tile a filter', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    at('2026-09-27T10:00:00+08:00');
    const list = await getTimesheetsList(reader.actor);
    expect(list?.cutOff).toMatchObject({ periodStart: CUT_OFF, periodEnd: '2026-09-25' });
    expect(list?.deadline).toBe('2026-09-26');
    expect(list?.cutOffs[0]?.label).toBe('Sep 11 – 25, 2026');
    const rows = list?.rows ?? [];
    expect(Object.values(list?.counts ?? {}).reduce((a, b) => a + b, 0)).toBe(rows.length);
    expect(rows.find((row) => row.employeeId === late.employeeId)).toMatchObject({
      status: 'open',
      filter: 'notSubmitted',
      statusText: 'Overdue',
      overdue: true,
      href: `/talent/timesheets/${late.employeeId}?cutOff=${CUT_OFF}`,
    });
    expect(rows.find((row) => row.employeeId === submitted.employeeId)).toMatchObject({
      filter: 'pendingSupervisor',
      overdue: false,
    });
    expect(rows.find((row) => row.employeeId === done.employeeId)?.filter).toBe('approved');
    // Someone with no timesheet for the cut-off is "Not submitted".
    expect(rows.find((row) => row.employeeId === outsider.employeeId)).toMatchObject({
      status: null,
      filter: 'notSubmitted',
    });

    const approved = await getTimesheetsList(reader.actor, { cutOff: CUT_OFF, status: 'approved' });
    expect(approved?.filter).toBe('approved');
    expect(approved?.rows.every((row) => row.filter === 'approved')).toBe(true);
    expect(approved?.counts).toEqual(list?.counts);

    expect(await getTimesheetsList(reader.actor, { cutOff: '2026-09-26' })).toBeNull();
    expect(await getTimesheetsList(reader.actor, { cutOff: '2026-09-12' })).toBeNull();
  });

  it('is refused without Talent Read', async () => {
    await expect(getTimesheetsList(outsider.actor)).rejects.toBeInstanceOf(AccessDeniedError);
  });
});
