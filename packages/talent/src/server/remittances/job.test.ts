import { beforeAll, describe, expect, it } from 'vitest';
import { Types } from 'mongoose';
import { connectDb } from '@pulse/db';
import { encryptSensitive } from '@pulse/core/server';
import {
  type Department,
  department,
  moveTo,
  notifications,
  type Person,
  person,
  seedPayrollSettings,
  setLeaveSettings,
} from '../testing/fixtures';
import {
  REMITTANCE_DUE_EVENT,
  REMITTANCE_OVERDUE_EVENT,
  REMITTANCE_REMINDERS_JOB,
  REMITTANCE_REMINDERS_SCHEDULE,
  remittanceReminderDedupeKey,
  runRemittanceReminders,
} from './job';
import { RemittanceReportModel } from './model';

// The remittance reminder job (docs/TESTING.md#remittance-tests, build step 2.11, decision 393 in
// docs/BUILD_PLAN.md): case R10 — with SSS October 2026 unpaid, `talent.remittanceDue` (soon) on
// Nov 25, (today) on Nov 30 and `talent.remittanceOverdue` on Dec 1, once each to every active HR
// user; a rerun the same day sends nothing; a paid agency month gets nothing; the System
// Administrators when no HR user is active. No amount in any notification. Made-up people only.

const at = (day: string) => new Date(`${day}T08:00:00+08:00`);

let NET: Department;
let hr1: Person;
let hr2: Person;
let admin: Person;

async function sssOctober() {
  return notifications({
    dedupeKey: {
      $in: (['soon', 'today', 'overdue'] as const).map((kind) =>
        remittanceReminderDedupeKey('sss', '2026-10', kind),
      ),
    },
  });
}

beforeAll(async () => {
  await connectDb();
  await RemittanceReportModel.init();
  await seedPayrollSettings();
  NET = await department('Network', 'NET');
  const HRD = await department('Human Resource', 'HR');
  hr1 = await person('Ana', 'Reyes', HRD, { talent: 'write' });
  hr2 = await person('Hana', 'Uy', HRD);
  admin = await person('Ada', 'Admin', NET, { admin: true });
  await setLeaveSettings({ goLiveDate: '2026-09-26' });
  // PhilHealth October 2026 is paid (a report stored as the service leaves it).
  await RemittanceReportModel.create({
    agency: 'philhealth',
    month: '2026-10',
    status: 'paid',
    generatedAt: new Date(),
    employeeCount: 0,
    employer: {
      registeredName: 'Made-up Inc.',
      businessAddress: '',
      tin: '',
      rdoCode: '',
      employerNumber: '',
      placeholder: true,
    },
    dueDate: new Date('2026-11-15T00:00:00+08:00'),
    formatId: null,
    rows: await encryptSensitive('{"rowsVersion":1,"rows":[]}'),
    totals: await encryptSensitive('{"amountDueCentavos":0}'),
    paymentId: new Types.ObjectId(),
  });
});

describe('the job and its schedule', () => {
  it('runs daily at 08:00 Manila with no data', () => {
    expect(REMITTANCE_REMINDERS_JOB.name).toBe('talent.remittanceReminders');
    expect(REMITTANCE_REMINDERS_SCHEDULE).toMatchObject({
      id: 'talent.remittanceReminders',
      pattern: '0 8 * * *',
      data: {},
    });
  });
});

describe('R10: SSS October 2026 unpaid', () => {
  it('sends nothing before the lead days', async () => {
    const result = await runRemittanceReminders(at('2026-11-04'));
    expect(result).toMatchObject({ date: '2026-11-04', months: 1 });
    expect(await sssOctober()).toHaveLength(0);
  });

  it('sends "soon" on Nov 25 to every active HR user, once', async () => {
    const first = await runRemittanceReminders(at('2026-11-25'));
    expect(first.unpaid).toBe(3);
    const sent = await sssOctober();
    expect(sent.map((note) => note.recipientUserId.toHexString()).sort()).toEqual(
      [hr1.userId, hr2.userId].sort(),
    );
    expect(sent[0]).toMatchObject({
      module: 'talent',
      event: REMITTANCE_DUE_EVENT,
      title: 'SSS remittance for October 2026 is due Nov 30, 2026',
      href: '/talent/remittances/2026-10/sss',
      dedupeKey: remittanceReminderDedupeKey('sss', '2026-10', 'soon'),
    });
    const again = await runRemittanceReminders(at('2026-11-25'));
    expect(again.notified).toBe(0);
    expect(await sssOctober()).toHaveLength(2);
  });

  it('sends "today" on Nov 30 and "overdue" on Dec 1, once each', async () => {
    await runRemittanceReminders(at('2026-11-30'));
    await runRemittanceReminders(at('2026-11-30'));
    await runRemittanceReminders(at('2026-12-01'));
    await runRemittanceReminders(at('2026-12-01'));
    const sent = await sssOctober();
    expect(sent).toHaveLength(6);
    const today = sent.filter((note) => note.dedupeKey?.endsWith(':today'));
    expect(today[0]).toMatchObject({
      event: REMITTANCE_DUE_EVENT,
      title: 'SSS remittance for October 2026 is due today',
    });
    const overdue = sent.filter((note) => note.dedupeKey?.endsWith(':overdue'));
    expect(overdue).toHaveLength(2);
    expect(overdue[0]).toMatchObject({
      event: REMITTANCE_OVERDUE_EVENT,
      title: 'SSS remittance for October 2026 is overdue (due Nov 30, 2026)',
    });
  });

  it('sends nothing for a paid agency month, and no amount in any reminder', async () => {
    const all = await notifications();
    expect(all.some((note) => note.dedupeKey?.includes(':philhealth:2026-10:'))).toBe(false);
    for (const note of all) expect(`${note.title}${note.body ?? ''}`).not.toMatch(/₱|\d+\.\d\d/);
    expect(all.some((note) => note.dedupeKey?.includes(':pagibig:2026-10:overdue'))).toBe(true);
  });

  it('goes to the System Administrators when no HR user is active', async () => {
    await moveTo(hr1, NET);
    await moveTo(hr2, NET);
    // November's BIR 1601-C is due Dec 10: "soon" from Dec 5.
    const result = await runRemittanceReminders(at('2026-12-05'));
    expect(result.months).toBe(2);
    const bir = await notifications({
      dedupeKey: remittanceReminderDedupeKey('bir1601c', '2026-11', 'soon'),
    });
    expect(bir.map((note) => note.recipientUserId.toHexString())).toEqual([admin.userId]);
    expect(bir[0]?.title).toBe('BIR 1601-C remittance for November 2026 is due Dec 10, 2026');
  });
});

describe('without a go-live date', () => {
  it('checks no month', async () => {
    await setLeaveSettings({ goLiveDate: null }, '2026-12-06');
    const result = await runRemittanceReminders(at('2026-12-07'));
    expect(result).toMatchObject({ months: 0, notified: 0 });
  });
});
