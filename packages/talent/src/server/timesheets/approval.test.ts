import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Types } from 'mongoose';
import { connectDb } from '@pulse/db';
import { AccessDeniedError, ActionError } from '@pulse/core';
import { OnboardingGateError } from '../../onboarding/gates';
import { TIMESHEET_APPROVED_MESSAGE, TIMESHEET_PENDING_MESSAGE } from '../../timesheets/schemas';
import {
  TIMESHEET_APPROVAL_TYPE,
  timesheetSubmitProblemMessage,
} from '../../timesheets/submission';
import { registerTalentApprovalTypes } from '../change-requests/service';
import { registerTalentApprovalSigner, uploadESignature } from '../e-signatures/service';
import { setNoSupervisorConfirmation } from '../employee-records/service';
import { EmployeeRecordModel } from '../employee-records/model';
import { OffsetEntryModel } from '../offset/model';
import { getOffsetBalance } from '../offset/service';
import { ReceiptClaimModel } from '../receipt-claims/model';
import { addReimbursement } from '../reimbursements/service';
import { ReimbursementModel } from '../reimbursements/model';
import {
  approvalRequest,
  auditEntries,
  database,
  decide,
  type Department,
  department,
  notifications,
  type Person,
  person,
  pngFile,
  seedPayrollSettings,
  separate,
  setPositionType,
  setReportingTo,
} from '../testing/fixtures';
import { TimeEntryModel, TimesheetModel } from './model';
import {
  createTimeEntry,
  deleteTimeEntry,
  getOwnTimesheetView,
  getTimesheetView,
  updateTimeEntry,
} from './service';
import { submitTimesheet, TIMESHEET_GONE } from './submission';

// Timesheet submission and approval (docs/TESTING.md#timesheet-approval-dtr-and-offset-tests:
// "Submitting", "Approval and the Done when"; decisions 278–285 in docs/BUILD_PLAN.md). Made-up
// people only. "Today" is Saturday 2026-09-26, 10:00 Manila: the cut-off 2026-09-11 to 2026-09-25
// has ended, and with the seeded deadline of 1 day it is due today.

const CUT_OFF = '2026-09-11';
const TODAY = new Date('2026-09-26T10:00:00+08:00');

let storageDir: string;
let NET: Department;
let OFF: Department;
let HRD: Department;
let BOD: Department;
let hr: Person;
let hrNoAccess: Person;
let admin: Person;
let boss: Person;
let boss2: Person;
let outsider: Person;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(TODAY);
});

afterEach(() => {
  vi.useRealTimers();
});

beforeAll(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(TODAY);
  storageDir = await mkdtemp(path.join(tmpdir(), 'pulse-test-storage-'));
  process.env.FILE_STORAGE_DIR = storageDir;
  await connectDb();
  await Promise.all([
    TimesheetModel.init(),
    TimeEntryModel.init(),
    OffsetEntryModel.init(),
    ReimbursementModel.init(),
    ReceiptClaimModel.init(),
    EmployeeRecordModel.init(),
  ]);
  await seedPayrollSettings();
  NET = await department('Network', 'NET');
  OFF = await department('Office', 'OFF');
  await setPositionType(OFF, 'standard');
  HRD = await department('Human Resource', 'HR');
  BOD = await department('Board of Directors', 'BOD');
  hr = await person('Hana', 'Reyes', HRD, { talent: 'write' });
  hrNoAccess = await person('Hugo', 'Ramos', HRD);
  admin = await person('Ada', 'Admin', NET, { admin: true });
  boss = await person('Bea', 'Tan', NET);
  boss2 = await person('Ben', 'Cruz', NET);
  outsider = await person('Otto', 'Gomez', NET);
  for (const approver of [hr, hrNoAccess, admin, boss, boss2]) {
    await uploadESignature(approver.actor, pngFile());
  }
  registerTalentApprovalSigner();
  registerTalentApprovalTypes();
  vi.useRealTimers();
});

afterAll(async () => {
  await rm(storageDir, { recursive: true, force: true });
});

/** A new Standard employee (Office) reporting to Bea and Ben, unless told otherwise. */
let count = 0;
async function employee(
  dept: Department = OFF,
  supervisors: Person[] = [boss, boss2],
): Promise<Person> {
  count += 1;
  const p = await person('Test', `Person${count}`, dept, { dateHired: '2025-01-01' });
  if (supervisors.length > 0) await setReportingTo(p, supervisors);
  return p;
}

const entry = (
  p: Person,
  date: string,
  timeIn: string,
  timeOut: string | null,
  extra = true,
  activity: string | null = 'Site survey',
) =>
  createTimeEntry(p.actor, {
    date,
    timeIn,
    timeOut,
    activity,
    clientId: null,
    extraHoursReason: extra ? 'Cut-over window' : null,
  });

async function timesheetOf(p: Person, cutOff = CUT_OFF): Promise<string> {
  const view = await getOwnTimesheetView(p.actor, { cutOff });
  if (!view?.timesheet.id) throw new Error('No timesheet.');
  return view.timesheet.id;
}

async function storedTimesheet(id: string) {
  return database()
    .collection('timesheets')
    .findOne({ _id: new Types.ObjectId(id) });
}

const submit = async (p: Person, cutOff = CUT_OFF) =>
  submitTimesheet(p.actor, { timesheetId: await timesheetOf(p, cutOff) });

describe('submitting', () => {
  it('refuses before the cut-off ends', async () => {
    vi.setSystemTime(new Date('2026-09-25T18:00:00+08:00'));
    const p = await employee();
    await expect(submit(p)).rejects.toThrow('You can submit this timesheet from Sep 26, 2026.');
  });

  it('refuses another person’s timesheet, and the system account', async () => {
    const p = await employee();
    const id = await timesheetOf(p);
    await expect(submitTimesheet(outsider.actor, { timesheetId: id })).rejects.toThrow(
      TIMESHEET_GONE,
    );
    await expect(submitTimesheet(hr.actor, { timesheetId: id })).rejects.toThrow(TIMESHEET_GONE);
    await expect(
      submitTimesheet({ ...admin.actor, employee: null }, { timesheetId: id }),
    ).rejects.toBeInstanceOf(AccessDeniedError);
  });

  it('refuses a pending or approved timesheet', async () => {
    const p = await employee();
    await submit(p);
    await expect(submit(p)).rejects.toThrow(TIMESHEET_PENDING_MESSAGE);
    await database()
      .collection('timesheets')
      .updateOne(
        { _id: new Types.ObjectId(await timesheetOf(p)) },
        { $set: { status: 'approved' } },
      );
    await expect(submit(p)).rejects.toThrow(TIMESHEET_APPROVED_MESSAGE);
  });

  it('refuses an entry with no time out, naming the day', async () => {
    const p = await employee();
    await entry(p, '2026-09-15', '08:00', null, false, null);
    await expect(submit(p)).rejects.toThrow(
      timesheetSubmitProblemMessage({ kind: 'openEntry', date: '2026-09-15' }),
    );
  });

  it('refuses a missing reportingTo item, naming it', async () => {
    const p = await employee(NET, []);
    const error = await submit(p).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(OnboardingGateError);
    expect((error as Error).message).toContain('Reports to');
  });

  it('refuses a reimbursement line whose receipt claim is gone', async () => {
    const p = await employee();
    const line = await addReimbursement(
      p.actor,
      {
        timesheetId: await timesheetOf(p),
        typeKey: 'meal',
        receiptDate: '2026-09-15',
        merchant: 'Made-up Diner',
        merchantTin: '300000001',
        receiptNumber: 'SI-1',
        amountCentavos: 25_000,
        clientId: null,
        pickUp: 'Office',
        dropOff: 'Client site',
        description: 'Lunch with the team',
      },
      pngFile('receipt.png'),
    );
    await database()
      .collection('receiptClaims')
      .updateOne({ claimId: new Types.ObjectId(line.id) }, { $set: { deletedAt: new Date() } });
    await expect(submit(p)).rejects.toThrow('Save this reimbursement line again: Made-up Diner');
  });

  it('refuses an inactive account', async () => {
    const p = await employee();
    const id = await timesheetOf(p);
    await separate(p);
    await expect(submitTimesheet(p.actor, { timesheetId: id })).rejects.toBeInstanceOf(ActionError);
    expect((await storedTimesheet(id))?.status).toBe('open');
  });

  it('submits an empty timesheet to the supervisors, in one transaction with its audit entry', async () => {
    const p = await employee();
    const result = await submit(p);
    expect(result).toMatchObject({ status: 'pendingSupervisor', submittedLate: false });
    const stored = await storedTimesheet(result.timesheetId);
    expect(stored).toMatchObject({ status: 'pendingSupervisor' });
    expect(stored?.approvalRequestId?.toHexString()).toBe(result.approvalRequestId);
    const request = await approvalRequest(result.approvalRequestId);
    expect(request).toMatchObject({
      type: TIMESHEET_APPROVAL_TYPE,
      status: 'pending',
      currentStep: 0,
      title: `Timesheet: Test Person${count} · Sep 11 – 25, 2026`,
      href: `/talent/timesheets/${p.employeeId}?cutOff=${CUT_OFF}`,
    });
    expect(request?.summary).toBe(
      'Standard timesheet · Worked 0.0 h · Offset 0.0 h · 0 manual times · No reimbursements',
    );
    const audits = (await auditEntries(TIMESHEET_APPROVAL_TYPE)).filter(
      (row) => row.record.id.toHexString() === result.timesheetId,
    );
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      action: 'update',
      reason: 'Submitted',
      record: { label: `${p.employeeNumber} · ${CUT_OFF}` },
    });
  });

  it('skips the supervisor step for "No supervisor" confirmed and for a Board member', async () => {
    const lone = await employee(NET, []);
    await setNoSupervisorConfirmation(hr.actor, {
      employeeId: lone.employeeId,
      version: 0,
      confirmed: true,
    });
    expect((await submit(lone)).status).toBe('pendingHr');
    const director = await employee(BOD, []);
    expect((await submit(director)).status).toBe('pendingHr');
  });

  it('marks a submission after the deadline as late', async () => {
    vi.setSystemTime(new Date('2026-09-27T09:00:00+08:00'));
    const p = await employee();
    expect((await submit(p)).submittedLate).toBe(true);
    const view = await getOwnTimesheetView(p.actor, { cutOff: CUT_OFF });
    expect(view?.approval?.submittedLate).toBe(true);
  });

  it('serializes a time entry save with a submit: an entry never lands on a submitted timesheet', async () => {
    for (let run = 0; run < 3; run += 1) {
      const p = await employee();
      const timesheetId = await timesheetOf(p);
      const [saved, submitted] = await Promise.allSettled([
        entry(p, '2026-09-16', '08:00', '17:00', false),
        submitTimesheet(p.actor, { timesheetId }),
      ]);
      expect(submitted.status).toBe('fulfilled');
      const stored = await storedTimesheet(timesheetId);
      const entries = await database()
        .collection('timeEntries')
        .find({ timesheetId: new Types.ObjectId(timesheetId) })
        .toArray();
      if (saved.status === 'fulfilled') {
        // The save won: the submit retried with the entry visible, after it.
        expect(entries).toHaveLength(1);
        expect(entries[0]?.createdAt.getTime()).toBeLessThanOrEqual(stored?.submittedAt.getTime());
      } else {
        expect(String(saved.reason)).toContain(TIMESHEET_PENDING_MESSAGE);
        expect(entries).toHaveLength(0);
      }
    }
  });
});

describe('approval, return and resubmission (the Done when)', () => {
  it('returns, resubmits, approves by a supervisor and HR, locks, and credits the offset (D13)', async () => {
    const p = await employee();
    // Step 2.4's case 10 (155 min) and D10 (120 min), both marked.
    await entry(p, '2026-09-14', '07:55', '19:30');
    const d10 = await entry(p, '2026-09-15', '08:00', '18:00');

    const first = await submit(p);
    expect(first.status).toBe('pendingSupervisor');
    const pendingView = await getOwnTimesheetView(p.actor, { cutOff: CUT_OFF });
    expect(pendingView?.approval?.banner).toMatchObject({
      kind: 'pendingSupervisor',
      approverNames: ['Bea Tan', 'Ben Cruz'],
    });
    await expect(entry(p, '2026-09-16', '08:00', '17:00')).rejects.toThrow(
      TIMESHEET_PENDING_MESSAGE,
    );

    // The supervisor, with no module access, opens it and returns it with remarks.
    const asBoss = await getTimesheetView(boss.actor, p.employeeId, { cutOff: CUT_OFF });
    expect(asBoss?.approval?.approverLink?.requestId).toBe(first.approvalRequestId);
    await decide(boss.actor, first.approvalRequestId, 'return', 'Sep 15 ends at 19:00.');
    const returned = await storedTimesheet(first.timesheetId);
    expect(returned).toMatchObject({ status: 'returned', returnRemarks: 'Sep 15 ends at 19:00.' });
    expect(returned?.returnedBy.toHexString()).toBe(boss.userId);
    expect(
      await notifications({
        event: 'core.approvalReturned',
        recipientUserId: new Types.ObjectId(p.userId),
      }),
    ).toHaveLength(1);
    const returnedView = await getOwnTimesheetView(p.actor, { cutOff: CUT_OFF });
    expect(returnedView?.approval?.banner).toMatchObject({
      kind: 'returned',
      returnedByName: 'Bea Tan',
      remarks: 'Sep 15 ends at 19:00.',
    });
    expect(returnedView?.approval?.submit?.buttonLabel).toBe('Resubmit');

    // The employee fixes the entry and resubmits: a new request linked to the old one.
    await updateTimeEntry(p.actor, {
      entryId: d10.id,
      version: d10.version,
      date: '2026-09-15',
      timeIn: '08:00',
      timeOut: '19:00',
      timeOutNextDay: false,
      activity: 'Site survey',
      clientId: null,
      extraHoursReason: 'Cut-over window',
    });
    const second = await submit(p);
    expect(second.status).toBe('pendingSupervisor');
    const request = await approvalRequest(second.approvalRequestId);
    expect(request?.previousRequestId?.toHexString()).toBe(first.approvalRequestId);
    expect(request?.currentStep).toBe(0);
    expect(request?.summary).toContain('Standard timesheet · Worked ');
    expect(request?.summary).toContain(' · Offset 4.6 h · 4 manual times · No reimbursements');

    // The supervisor approves: waiting for HR. The other supervisor is told it was settled.
    await decide(boss.actor, second.approvalRequestId, 'approve');
    expect((await storedTimesheet(first.timesheetId))?.status).toBe('pendingHr');
    expect(
      (
        await notifications({
          event: 'core.approvalSettled',
          recipientUserId: new Types.ObjectId(boss2.userId),
        })
      ).length,
    ).toBeGreaterThan(0);

    // HR (without Talent Read) opens it read-only and approves it: locked and credited.
    const asHr = await getTimesheetView(hrNoAccess.actor, p.employeeId, { cutOff: CUT_OFF });
    expect(asHr?.employee).toEqual({
      id: p.employeeId,
      name: `Test Person${count}`,
      employeeNumber: p.employeeNumber,
    });
    expect(asHr?.approval?.approverLink?.requestId).toBe(second.approvalRequestId);
    const before = (await getOffsetBalance(p.actor, p.employeeId))?.balanceMinutes ?? 0;
    await decide(hrNoAccess.actor, second.approvalRequestId, 'approve');
    const approved = await storedTimesheet(first.timesheetId);
    expect(approved).toMatchObject({ status: 'approved' });
    expect(approved?.approvedBy.toHexString()).toBe(hrNoAccess.userId);

    const credits = await database()
      .collection('offsetEntries')
      .find({ timesheetId: new Types.ObjectId(first.timesheetId) })
      .toArray();
    expect(credits).toHaveLength(1);
    expect(credits[0]).toMatchObject({ kind: 'credit', minutes: 275 });
    expect((await getOffsetBalance(p.actor, p.employeeId))?.balanceMinutes).toBe(before + 275);

    const view = await getOwnTimesheetView(p.actor, { cutOff: CUT_OFF });
    expect(view?.approval?.banner).toMatchObject({
      kind: 'approved',
      approvedByName: 'Hugo Ramos',
    });
    expect(view?.approval?.lockedMessage).toBe(TIMESHEET_APPROVED_MESSAGE);
    expect(view?.offset?.credited).toEqual({ minutes: 275, creditedOn: '2026-09-26' });
    expect(view?.dtr?.final).toBe(true);

    const audits = (await auditEntries(TIMESHEET_APPROVAL_TYPE))
      .filter((row) => row.record.id.toHexString() === first.timesheetId)
      .map((row) => row.reason);
    expect(audits).toEqual([
      'Submitted',
      'Sep 15 ends at 19:00.',
      'Resubmitted',
      'Approved by supervisor',
      'Approved',
    ]);
    const offsetAudit = (await auditEntries('talent.offsetEntry')).find(
      (row) => row.record.id.toHexString() === credits[0]?._id.toHexString(),
    );
    expect(offsetAudit).toMatchObject({
      action: 'create',
      record: { label: `${p.employeeNumber} · 2026-09-26` },
    });

    // Locked for good: no entry or line changes, and the unique index refuses a second credit.
    await expect(entry(p, '2026-09-16', '08:00', '17:00')).rejects.toThrow(
      TIMESHEET_APPROVED_MESSAGE,
    );
    const stored = await TimeEntryModel.findById(d10.id).lean();
    await expect(
      deleteTimeEntry(p.actor, { entryId: d10.id, version: stored?.version ?? 0 }),
    ).rejects.toThrow(TIMESHEET_APPROVED_MESSAGE);
    await expect(submit(p)).rejects.toThrow(TIMESHEET_APPROVED_MESSAGE);
    await expect(
      OffsetEntryModel.create({
        employeeId: new Types.ObjectId(p.employeeId),
        kind: 'credit',
        minutes: 1,
        effectiveOn: new Date('2026-09-26T00:00:00+08:00'),
        timesheetId: new Types.ObjectId(first.timesheetId),
      }),
    ).rejects.toMatchObject({ code: 11000 });
  });

  it('offers approve and return only (no reject)', async () => {
    const p = await employee();
    const { approvalRequestId } = await submit(p);
    await expect(decide(boss.actor, approvalRequestId, 'reject', 'No.')).rejects.toThrow();
    expect((await approvalRequest(approvalRequestId))?.status).toBe('pending');
  });

  it('sends HR’s own timesheet to the other HR users at the HR step', async () => {
    const self = await employee(HRD, [boss]);
    const { approvalRequestId } = await submit(self);
    await decide(boss.actor, approvalRequestId, 'approve');
    const request = await approvalRequest(approvalRequestId);
    const hrStep = request?.steps[1];
    const approverIds = (hrStep?.approvers ?? []).map((a: { userId: Types.ObjectId }) =>
      a.userId.toHexString(),
    );
    expect(approverIds).toContain(hr.userId);
    expect(approverIds).toContain(hrNoAccess.userId);
    expect(approverIds).not.toContain(self.userId);
  });

  it('credits nothing for an Overtime timesheet whose extra hours are overtime', async () => {
    const p = await employee(NET, [boss]);
    await entry(p, '2026-09-14', '08:00', '19:00');
    const { approvalRequestId, timesheetId } = await submit(p);
    await decide(boss.actor, approvalRequestId, 'approve');
    await decide(hr.actor, approvalRequestId, 'approve');
    expect((await storedTimesheet(timesheetId))?.status).toBe('approved');
    expect(
      await database()
        .collection('offsetEntries')
        .countDocuments({ timesheetId: new Types.ObjectId(timesheetId) }),
    ).toBe(0);
  });
});

describe('who sees a timesheet', () => {
  it('lets an approver open the timesheet they decide, and nobody else without a part in it', async () => {
    const p = await employee(NET, [boss]);
    await submit(p);
    // Hugo (HR, no Talent Read) is an approver only once the HR step is pending.
    await expect(
      getTimesheetView(hrNoAccess.actor, p.employeeId, { cutOff: CUT_OFF }),
    ).rejects.toBeInstanceOf(AccessDeniedError);
    const view = await getTimesheetView(boss.actor, p.employeeId, { cutOff: CUT_OFF });
    expect(view?.own).toBe(false);
    await decide(boss.actor, view?.approval?.approverLink?.requestId ?? '', 'approve');
    expect(
      (await getTimesheetView(hrNoAccess.actor, p.employeeId, { cutOff: CUT_OFF }))?.employee,
    ).toEqual({ id: p.employeeId, name: `Test Person${count}`, employeeNumber: p.employeeNumber });
    // Another cut-off of the same employee isn't theirs to open.
    await expect(
      getTimesheetView(hrNoAccess.actor, p.employeeId, { cutOff: '2026-08-26' }),
    ).rejects.toBeInstanceOf(AccessDeniedError);
    await expect(
      getTimesheetView(outsider.actor, p.employeeId, { cutOff: CUT_OFF }),
    ).rejects.toBeInstanceOf(AccessDeniedError);
    await expect(getOffsetBalance(outsider.actor, p.employeeId)).rejects.toBeInstanceOf(
      AccessDeniedError,
    );
    expect((await getOffsetBalance(hrNoAccess.actor, p.employeeId))?.balanceMinutes).toBe(0);
  });

  it('shows "Not submitted · Due" after the cut-off ends, and the submit sheet', async () => {
    const p = await employee();
    await entry(p, '2026-09-14', '08:16', '17:00', false);
    const view = await getOwnTimesheetView(p.actor, { cutOff: CUT_OFF });
    expect(view?.approval).toMatchObject({
      statusText: 'Not submitted',
      banner: { kind: 'notSubmitted', deadline: '2026-09-26', overdue: false },
      deadline: '2026-09-26',
      lockedMessage: null,
    });
    expect(view?.approval?.submit).toMatchObject({
      buttonLabel: 'Submit timesheet',
      daysPresent: 1,
      daysLate: 1,
      manualTimeCount: 2,
      empty: false,
      problems: [],
    });
    expect(view?.dtr?.days[0]?.date).toBe('2026-09-25');
  });
});
