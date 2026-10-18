import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Types } from 'mongoose';
import { connectDb } from '@pulse/db';
import { AccessDeniedError } from '@pulse/core';
import { openAccessibleFile } from '@pulse/core/server';
import { OnboardingGateError } from '../../onboarding/gates';
import {
  LEAVE_ADJUSTED_EVENT,
  TIME_OFF_CANCELLED_EVENT,
  TIME_OFF_REQUEST_TYPE,
} from '../../time-off/kinds';
import { OFFSET_NO_LONGER_COVERED_MESSAGE } from '../../time-off/rules';
import { CONFIDENTIAL_LEAVE_TITLE } from '../../time-off/views';
import { registerTalentApprovalTypes } from '../change-requests/service';
import { getDtr } from '../dtr/service';
import { registerTalentApprovalSigner, uploadESignature } from '../e-signatures/service';
import { EmployeeRecordModel } from '../employee-records/model';
import { setNoSupervisorConfirmation } from '../employee-records/service';
import { registerTalentFileAccess } from '../files/registrations';
import { LeaveEntryModel } from '../leave/model';
import { leaveBalanceOf } from '../leave/service';
import { OffsetEntryModel } from '../offset/model';
import { offsetBalanceOf } from '../offset/service';
import {
  approvalRequest,
  auditEntries,
  currentUser,
  decide,
  type Department,
  department,
  holiday,
  leaveBalanceEntry,
  notifications,
  offsetBalanceEntry,
  pdfFile,
  type Person,
  person,
  pngFile,
  seedPayrollSettings,
  setHoliday,
  setReportingTo,
  setSex,
} from '../testing/fixtures';
import { TimeEntryModel, TimesheetModel } from '../timesheets/model';
import { createTimeEntry } from '../timesheets/service';
import { TimeOffRefusedError } from './checks';
import { TimeOffFilingLockModel, TimeOffRequestModel } from './model';
import { reconcileTimeOffRequests } from './reconcile';
import {
  cancelTimeOff,
  fileTimeOff,
  getEmployeeTimeOff,
  getOwnTimeOff,
  getTimeOffRequestPage,
  previewTimeOff,
  resendTimeOff,
  TIME_OFF_NOT_RETURNED,
} from './service';

// Leave and offset time off requests (docs/TESTING.md#leave-and-time-off-tests; cases L1, L2,
// L5, L9, L10, O1–O5 and H1 of docs/modules/talent.md#leave-offset-time-off-and-opening-balances-
// build-step-28, plus routing, return, resend, reject, cancel and concurrent filing). Made-up
// people only. "Today" is Monday 2026-10-19, 10:00 Manila, with the seeded schedule (Monday to
// Friday, 08:00–17:00, break 12:00–13:00, grace 15 minutes) and the seeded leave types.

const TODAY = new Date('2026-10-19T10:00:00+08:00');

let storageDir: string;
let NET: Department;
let HRD: Department;
let hr: Person;
let hr2: Person;
let admin: Person;
let boss: Person;
let outsider: Person;

function at(instant: Date): void {
  vi.setSystemTime(instant);
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  at(TODAY);
});

afterEach(() => {
  vi.useRealTimers();
});

beforeAll(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  at(TODAY);
  storageDir = await mkdtemp(path.join(tmpdir(), 'pulse-test-storage-'));
  process.env.FILE_STORAGE_DIR = storageDir;
  await connectDb();
  await Promise.all([
    TimeOffRequestModel.init(),
    TimeOffFilingLockModel.init(),
    LeaveEntryModel.init(),
    OffsetEntryModel.init(),
    TimesheetModel.init(),
    TimeEntryModel.init(),
    EmployeeRecordModel.init(),
  ]);
  await seedPayrollSettings();
  NET = await department('Network', 'NET');
  HRD = await department('Human Resource', 'HR');
  hr = await person('Hana', 'Reyes', HRD, { talent: 'write' });
  hr2 = await person('Hilda', 'Ramos', HRD, { talent: 'read' });
  admin = await person('Ada', 'Admin', NET, { admin: true });
  boss = await person('Bea', 'Tan', NET);
  outsider = await person('Otto', 'Gomez', NET, { talent: 'read' });
  for (const approver of [hr, hr2, admin, boss]) await uploadESignature(approver.actor, pngFile());
  registerTalentApprovalSigner();
  registerTalentApprovalTypes();
  registerTalentFileAccess();
  vi.useRealTimers();
});

afterAll(async () => {
  await rm(storageDir, { recursive: true, force: true });
});

let count = 0;
/** A new Regular Network employee hired 2024-01-01, reporting to Bea unless told otherwise. */
async function employee({
  dept = NET,
  supervisors = [boss],
  status = 'Regular' as const,
}: {
  dept?: Department;
  supervisors?: Person[];
  status?: 'Regular' | 'Probationary';
} = {}): Promise<Person> {
  count += 1;
  const p = await person('Test', `Person${count}`, dept, { status });
  if (supervisors.length > 0) await setReportingTo(p, supervisors);
  return p;
}

const vl = (startDate: string, endDate = startDate, extra: Record<string, unknown> = {}) => ({
  kind: 'leave',
  leaveTypeKey: 'vacation',
  startDate,
  endDate,
  portion: 'whole',
  reason: null,
  ...extra,
});

const offset = (
  startDate: string,
  fromTime: string | null = null,
  toTime: string | null = null,
  endDate = startDate,
) => ({
  kind: 'offset',
  startDate,
  endDate,
  portion: fromTime ? 'part' : 'whole',
  fromTime,
  toTime,
  reason: null,
});

async function refusal(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error('Expected a refusal.');
}

async function stored(id: string) {
  const request = await TimeOffRequestModel.findById(id).lean();
  if (!request) throw new Error('No request.');
  return request;
}

async function approvalOf(id: string) {
  const request = await stored(id);
  const approval = await approvalRequest(request.approvalRequestId?.toHexString() ?? '');
  if (!approval) throw new Error('No approval request.');
  return approval;
}

const approverIds = (approval: Awaited<ReturnType<typeof approvalOf>>) =>
  (approval.steps[0]?.approvers ?? []).map((a: { userId: Types.ObjectId }) =>
    a.userId.toHexString(),
  );

async function decideRequest(
  who: Person,
  id: string,
  decision: 'approve' | 'return' | 'reject',
  remarks: string | null = null,
): Promise<void> {
  const request = await stored(id);
  await decide(who.actor, request.approvalRequestId?.toHexString() ?? '', decision, remarks);
}

describe('filing leave', () => {
  it('refuses VL filed 10 days ahead (L1, the Done when)', async () => {
    const p = await employee();
    await leaveBalanceEntry(p, 'vacation', 10);
    const message = await refusal(fileTimeOff(p.actor, vl('2026-10-29')));
    expect(message).toBe(
      'Vacation leave must be filed at least 14 days before the first day, so by Oct 15 for Oct 29.',
    );
    expect(await TimeOffRequestModel.countDocuments({ employeeId: p.employeeId })).toBe(0);
  });

  it('accepts VL 14 days ahead and charges it at approval (L2)', async () => {
    const p = await employee();
    await leaveBalanceEntry(p, 'vacation', 10);
    const filed = await fileTimeOff(p.actor, vl('2026-11-02'));
    expect(filed.number).toMatch(/^LV-2026-\d{4}$/);
    const pending = await stored(filed.id);
    expect(pending).toMatchObject({
      status: 'pending',
      chargeableHalfDays: 2,
      paidHalfDays: 2,
      unpaidHalfDays: 0,
    });
    const approval = await approvalOf(filed.id);
    expect(approval.type).toBe('talent.leave');
    expect(approval.title).toBe(`Leave: Test ${p.lastName} · VL · Nov 2, 2026 (1 day)`);
    expect(approverIds(approval)).toEqual([boss.userId]);
    // Pending holds the balance but writes nothing.
    expect(await leaveBalanceOf(p.employeeId, 'vacation')).toBe(10);

    await decideRequest(boss, filed.id, 'approve');
    expect((await stored(filed.id)).status).toBe('approved');
    expect(await leaveBalanceOf(p.employeeId, 'vacation')).toBe(8);
    const usage = await LeaveEntryModel.findOne({ sourceId: new Types.ObjectId(filed.id) }).lean();
    expect(usage).toMatchObject({ kind: 'usage', halfDays: -2, sourceType: TIME_OFF_REQUEST_TYPE });
    const audit = await auditEntries(TIME_OFF_REQUEST_TYPE);
    expect(
      audit.filter((e) => e.record.id.toHexString() === filed.id).map((e) => e.action),
    ).toEqual(['create', 'update']);
    expect(audit[0]?.record.label).toMatch(/^LV-2026-\d{4}$/);
  });

  it('previews and stores leave without pay from the last day (L5)', async () => {
    const p = await employee();
    await leaveBalanceEntry(p, 'vacation', 4);
    const preview = await previewTimeOff(p.actor, vl('2026-11-02', '2026-11-04'));
    expect(preview).toMatchObject({
      chargeableHalfDays: 6,
      paidHalfDays: 4,
      unpaidHalfDays: 2,
      problems: [],
    });
    const filed = await fileTimeOff(p.actor, vl('2026-11-02', '2026-11-04'));
    await decideRequest(boss, filed.id, 'approve');
    expect(await stored(filed.id)).toMatchObject({ paidHalfDays: 4, unpaidHalfDays: 2 });
    expect(await leaveBalanceOf(p.employeeId, 'vacation')).toBe(0);

    at(new Date('2026-11-05T10:00:00+08:00'));
    const dtr = await getDtr(p.actor, p.employeeId, '2026-11-02', '2026-11-04');
    const days = dtr?.periods.flatMap((period) => period.days) ?? [];
    expect(days.map((day) => day.status)).toEqual([
      'onLeavePaid',
      'onLeavePaid',
      'leaveWithoutPay',
    ]);
    expect(days[2]?.leaveWithoutPayDays).toBe(1);
    expect(days[0]?.timeOff[0]?.shortName).toBe('VL');
  });

  it('refuses VL and SL to a Probationary employee (L9)', async () => {
    const p = await employee({ status: 'Probationary' });
    const message = await refusal(fileTimeOff(p.actor, vl('2026-11-09')));
    expect(message).toMatch(/^Probationary employees can’t use VL or SL\./);
    const sick = await refusal(
      fileTimeOff(p.actor, { ...vl('2026-10-16'), leaveTypeKey: 'sick' }, pdfFile()),
    );
    expect(sick).toMatch(/^Probationary employees can’t use VL or SL\./);
  });

  it('files SL after the sick day with its certificate only (L10)', async () => {
    const p = await employee();
    await leaveBalanceEntry(p, 'sick', 10);
    const sl = (day: string) => ({ ...vl(day), leaveTypeKey: 'sick' });
    expect(await refusal(fileTimeOff(p.actor, sl('2026-10-20')))).toBe(
      'Sick leave is filed on or after the sick day.',
    );
    const missing = await refusal(fileTimeOff(p.actor, sl('2026-10-16')));
    expect(missing).toBe('Attach the medical certificate.');
    const filed = await fileTimeOff(p.actor, sl('2026-10-16'), pdfFile('certificate.pdf'));
    const request = await stored(filed.id);
    expect(request.attachmentFileId).not.toBeNull();
    expect((await approvalOf(filed.id)).summary).toContain('Medical certificate attached');

    // The attachment opens for the employee, the approver and HR (audited), not others.
    const fileId = request.attachmentFileId?.toHexString() ?? '';
    const reveals = async () =>
      (await auditEntries(TIME_OFF_REQUEST_TYPE)).filter((e) => e.action === 'reveal').length;
    const before = await reveals();
    for (const viewer of [p, boss, hr]) {
      const opened = await openAccessibleFile(currentUser(viewer), fileId);
      expect(opened, `${viewer.firstName} opens`).not.toBeNull();
      await opened?.stream.cancel();
    }
    expect(await reveals()).toBe(before + 3);
    expect(await openAccessibleFile(currentUser(outsider), fileId)).toBeNull();
  });

  it('keeps self-service to the own employee and the gate', async () => {
    const lone = await employee({ supervisors: [] });
    await expect(fileTimeOff(lone.actor, vl('2026-11-09'))).rejects.toBeInstanceOf(
      OnboardingGateError,
    );
    const system = { ...admin.actor, employee: null };
    await expect(fileTimeOff(system, vl('2026-11-09'))).rejects.toBeInstanceOf(AccessDeniedError);
    // An employee id in the input is ignored: the request is the signed-in user's own.
    const p = await employee();
    await leaveBalanceEntry(p, 'vacation', 2);
    const filed = await fileTimeOff(p.actor, { ...vl('2026-11-09'), employeeId: boss.employeeId });
    expect((await stored(filed.id)).employeeId.toHexString()).toBe(p.employeeId);
  });

  it('serializes overlapping filings of one employee (concurrent filing)', async () => {
    const p = await employee();
    await leaveBalanceEntry(p, 'vacation', 10);
    const results = await Promise.allSettled([
      fileTimeOff(p.actor, vl('2026-11-10', '2026-11-11')),
      fileTimeOff(p.actor, vl('2026-11-11', '2026-11-12')),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const refused = results.find((r) => r.status === 'rejected');
    expect((refused as PromiseRejectedResult).reason).toBeInstanceOf(TimeOffRefusedError);
    expect((refused as PromiseRejectedResult).reason.message).toMatch(
      /^You already have time off on Nov 11\./,
    );
    expect(
      await TimeOffRequestModel.countDocuments({ employeeId: new Types.ObjectId(p.employeeId) }),
    ).toBe(1);
  });
});

describe('offset time off', () => {
  it('covers part of a day and lowers the balance (O1)', async () => {
    const p = await employee();
    await offsetBalanceEntry(p, 275);
    const filed = await fileTimeOff(p.actor, offset('2026-11-02', '13:00', '17:00'));
    expect(filed.number).toMatch(/^OFS-2026-\d{4}$/);
    expect(await stored(filed.id)).toMatchObject({ minutes: 240, chargeableHalfDays: null });
    expect((await approvalOf(filed.id)).title).toBe(
      `Offset time off: Test ${p.lastName} · Nov 2, 1:00 – 5:00 PM (4.0 h)`,
    );
    await decideRequest(boss, filed.id, 'approve');
    expect(await offsetBalanceOf(p.employeeId)).toBe(35);

    at(new Date('2026-11-02T18:00:00+08:00'));
    await createTimeEntry(p.actor, {
      date: '2026-11-02',
      timeIn: '08:00',
      timeOut: '12:00',
      activity: 'Site survey',
      clientId: null,
      extraHoursReason: null,
    });
    at(new Date('2026-11-03T10:00:00+08:00'));
    const dtr = await getDtr(p.actor, p.employeeId, '2026-11-02', '2026-11-02');
    const day = dtr?.periods[0]?.days[0];
    expect(day?.status).toBe('present');
    expect(day?.undertimeMinutes).toBe(0);
    expect(day?.timeOff[0]).toMatchObject({ status: 'offsetPaid', minutes: 240 });
  });

  it('refuses more than the available balance (O2)', async () => {
    const p = await employee();
    await offsetBalanceEntry(p, 35);
    expect(await refusal(fileTimeOff(p.actor, offset('2026-11-02')))).toBe(
      'This needs 8.0 h, more than your available offset balance of 0.6 h.',
    );
  });

  it('refuses a part off the step or below the minimum (O3)', async () => {
    const p = await employee();
    await offsetBalanceEntry(p, 600);
    expect(await refusal(fileTimeOff(p.actor, offset('2026-11-02', '13:00', '13:45')))).toBe(
      'Offset time off is taken in 30-minute steps.',
    );
    expect(await refusal(fileTimeOff(p.actor, offset('2026-11-02', '13:00', '13:30')))).toBe(
      'Offset time off is at least 1.0 h.',
    );
  });

  it('refuses offset time off that has already started (O4)', async () => {
    const p = await employee();
    await offsetBalanceEntry(p, 600);
    expect(await refusal(fileTimeOff(p.actor, offset('2026-10-19', '08:00', '12:00')))).toMatch(
      /^Offset time off must start after you file it\./,
    );
  });

  it('shows a whole approved day as offset on the DTR (O5, the Done when)', async () => {
    const p = await employee();
    await offsetBalanceEntry(p, 600);
    const filed = await fileTimeOff(p.actor, offset('2026-11-02'));
    await decideRequest(boss, filed.id, 'approve');
    expect(await offsetBalanceOf(p.employeeId)).toBe(120);
    expect((await getOwnTimeOff(p.actor)).requests[0]?.status).toBe('approved');
    at(new Date('2026-11-03T10:00:00+08:00'));
    const day = (await getDtr(boss.actor, p.employeeId, '2026-11-02', '2026-11-02'))?.periods[0]
      ?.days[0];
    expect(day?.status).toBe('offsetPaid');
    expect(day?.timeOff[0]?.minutes).toBe(480);
  });

  it('refuses an approval the balance no longer covers', async () => {
    const p = await employee();
    await offsetBalanceEntry(p, 480);
    const filed = await fileTimeOff(p.actor, offset('2026-11-03'));
    await offsetBalanceEntry(p, -240);
    await expect(decideRequest(boss, filed.id, 'approve')).rejects.toThrow(
      OFFSET_NO_LONGER_COVERED_MESSAGE,
    );
    expect((await stored(filed.id)).status).toBe('pending');
  });
});

describe('routing', () => {
  it('sends an empty reporting line to HR, and an HR requester’s to the System Administrator', async () => {
    const lone = await employee({ supervisors: [] });
    await setNoSupervisorConfirmation(hr.actor, {
      employeeId: lone.employeeId,
      version: 0,
      confirmed: true,
    });
    await offsetBalanceEntry(lone, 600);
    const filed = await fileTimeOff(lone.actor, offset('2026-11-02'));
    expect(approverIds(await approvalOf(filed.id)).sort()).toEqual([hr.userId, hr2.userId].sort());

    const hrLone = await employee({ dept: HRD, supervisors: [] });
    await setNoSupervisorConfirmation(admin.actor, {
      employeeId: hrLone.employeeId,
      version: 0,
      confirmed: true,
    });
    await offsetBalanceEntry(hrLone, 600);
    const own = await fileTimeOff(hrLone.actor, offset('2026-11-02'));
    const approval = await approvalOf(own.id);
    expect(approval.steps[0]?.routedToSystemAdministrator).toBe(true);
    expect(approverIds(approval)).toContain(admin.userId);
    expect(approverIds(approval)).not.toContain(hr.userId);
  });

  it('sends VAWC leave to HR only and hides its type from the supervisor', async () => {
    const p = await employee();
    await setSex(p, 'female');
    const filed = await fileTimeOff(
      p.actor,
      { ...vl('2026-10-26'), leaveTypeKey: 'vawc', reason: 'Made-up reason' },
      pdfFile('certification.pdf'),
    );
    const approval = await approvalOf(filed.id);
    expect(approval.title.startsWith(`${CONFIDENTIAL_LEAVE_TITLE}: `)).toBe(true);
    expect(approval.title).not.toContain('VAWC');
    expect(approval.summary).not.toMatch(/certification/i);
    expect(approverIds(approval)).toEqual(expect.arrayContaining([hr.userId, hr2.userId]));
    expect(approverIds(approval)).not.toContain(boss.userId);

    const seen = await getEmployeeTimeOff(boss.actor, p.employeeId);
    const row = seen?.requests.find((request) => request.id === filed.id);
    expect(row).toMatchObject({
      typeLabel: 'Leave',
      leaveTypeKey: null,
      reason: null,
      canOpenAttachment: false,
    });
    expect(seen?.balances?.perYear.map((use) => use.typeKey)).not.toContain('vawc');
    const own = (await getOwnTimeOff(p.actor)).requests.find((r) => r.id === filed.id);
    expect(own).toMatchObject({ typeLabel: 'VAWC', reason: 'Made-up reason' });

    // HR's return remarks are a reason too: hidden from the supervisor, in the history as well.
    await decideRequest(hr, filed.id, 'return', 'Made-up remarks');
    const page = await getTimeOffRequestPage(boss.actor, filed.id);
    expect(page?.typeName).toBe('Leave');
    expect(page?.request.remarks).toBeNull();
    expect(JSON.stringify(page?.approvals)).not.toContain('Made-up remarks');
    const ownPage = await getTimeOffRequestPage(p.actor, filed.id);
    expect(ownPage?.request.remarks).toBe('Made-up remarks');

    // An HR requester's VAWC goes to the System Administrator, never the other HR users.
    const hrEmployee = await employee({ dept: HRD });
    await setSex(hrEmployee, 'female');
    const hrFiled = await fileTimeOff(
      hrEmployee.actor,
      { ...vl('2026-10-26'), leaveTypeKey: 'vawc' },
      pdfFile('certification.pdf'),
    );
    const hrApproval = await approvalOf(hrFiled.id);
    expect(approverIds(hrApproval)).toContain(admin.userId);
    expect(approverIds(hrApproval)).not.toContain(hr.userId);
    expect(approverIds(hrApproval)).not.toContain(boss.userId);
  });
});

describe('return, resend, reject and cancel', () => {
  it('edits and sends a returned request again, linked to the first', async () => {
    const p = await employee();
    await leaveBalanceEntry(p, 'vacation', 10);
    const filed = await fileTimeOff(p.actor, vl('2026-11-16'));
    const first = (await stored(filed.id)).approvalRequestId?.toHexString();
    await decideRequest(boss, filed.id, 'return', 'Choose another day.');
    expect(await stored(filed.id)).toMatchObject({
      status: 'returned',
      remarks: 'Choose another day.',
    });
    // A pending request can't be sent again, and a returned one keeps its kind.
    const resent = await resendTimeOff(p.actor, filed.id, vl('2026-11-17'));
    expect(resent).toMatchObject({ number: filed.number, status: 'pending' });
    const after = await stored(filed.id);
    expect(after.startDate.toISOString()).toBe('2026-11-16T16:00:00.000Z');
    const second = await approvalOf(filed.id);
    expect(second.previousRequestId?.toHexString()).toBe(first);
    expect(await refusal(resendTimeOff(p.actor, filed.id, vl('2026-11-18')))).toBe(
      TIME_OFF_NOT_RETURNED,
    );
    // Another person can't touch it.
    const other = await employee();
    await expect(resendTimeOff(other.actor, filed.id, vl('2026-11-18'))).rejects.toThrow(
      /can’t be found/,
    );

    await decideRequest(boss, filed.id, 'reject', 'Busy week.');
    expect((await stored(filed.id)).status).toBe('rejected');
    expect(await refusal(cancelTimeOff(p.actor, { requestId: filed.id, reason: null }))).toMatch(
      /^Only a returned request/,
    );
  });

  it('cancels an approved request before its first day and gives the balance back', async () => {
    const p = await employee();
    await leaveBalanceEntry(p, 'vacation', 10);
    const filed = await fileTimeOff(p.actor, vl('2026-11-19'));
    await decideRequest(boss, filed.id, 'approve');
    expect(await leaveBalanceOf(p.employeeId, 'vacation')).toBe(8);
    await cancelTimeOff(p.actor, { requestId: filed.id, reason: 'Plans changed.' });
    expect(await stored(filed.id)).toMatchObject({
      status: 'cancelled',
      cancelReason: 'Plans changed.',
    });
    expect(await leaveBalanceOf(p.employeeId, 'vacation')).toBe(10);
    const told = await notifications({ event: TIME_OFF_CANCELLED_EVENT });
    expect(told.map((n) => n.recipientUserId.toHexString())).toContain(boss.userId);

    // From its first day on, an approved request can't be cancelled.
    const later = await fileTimeOff(p.actor, vl('2026-11-20'));
    await decideRequest(boss, later.id, 'approve');
    at(new Date('2026-11-20T09:00:00+08:00'));
    expect(await refusal(cancelTimeOff(p.actor, { requestId: later.id, reason: null }))).toMatch(
      /has started/,
    );
  });

  it('opens a request page for its approver and refuses an outsider without Talent Read', async () => {
    const p = await employee();
    await leaveBalanceEntry(p, 'vacation', 10);
    const filed = await fileTimeOff(p.actor, vl('2026-11-23'));
    const page = await getTimeOffRequestPage(boss.actor, filed.id);
    expect(page?.approverLink?.href).toMatch(/^\/approvals\?request=/);
    expect(page?.typeName).toBe('Vacation leave');
    const stranger = await employee({ supervisors: [] });
    await expect(getTimeOffRequestPage(stranger.actor, filed.id)).rejects.toBeInstanceOf(
      AccessDeniedError,
    );
  });
});

describe('the holidays-changed listener (H1)', () => {
  it('gives back a confirmed holiday and charges a deleted one, once', async () => {
    const p = await employee();
    await leaveBalanceEntry(p, 'vacation', 10);
    const holidayId = await holiday('2026-11-30', { status: 'draft' });
    const filed = await fileTimeOff(p.actor, vl('2026-11-30', '2026-12-01'));
    await decideRequest(boss, filed.id, 'approve');
    expect(await stored(filed.id)).toMatchObject({ chargeableHalfDays: 4, paidHalfDays: 4 });
    expect(await leaveBalanceOf(p.employeeId, 'vacation')).toBe(6);

    await setHoliday(holidayId, { status: 'confirmed' });
    expect(await reconcileTimeOffRequests(['2026-11-30'])).toMatchObject({ adjusted: 1 });
    expect(await stored(filed.id)).toMatchObject({ chargeableHalfDays: 2, paidHalfDays: 2 });
    expect(await leaveBalanceOf(p.employeeId, 'vacation')).toBe(8);
    const told = await notifications({ event: LEAVE_ADJUSTED_EVENT });
    expect(told.at(-1)?.title).toBe(
      'Your VL balance changed by +1.0 day: the holidays on Nov 30 changed',
    );
    // Idempotent.
    expect(await reconcileTimeOffRequests(['2026-11-30'])).toMatchObject({ adjusted: 0 });

    await setHoliday(holidayId, { deleted: true });
    await reconcileTimeOffRequests(['2026-11-30']);
    expect(await stored(filed.id)).toMatchObject({ chargeableHalfDays: 4, paidHalfDays: 4 });
    expect(await leaveBalanceOf(p.employeeId, 'vacation')).toBe(6);
  });

  it('does nothing without changed dates', async () => {
    expect(await reconcileTimeOffRequests([])).toEqual({ requests: 0, adjusted: 0 });
  });
});
