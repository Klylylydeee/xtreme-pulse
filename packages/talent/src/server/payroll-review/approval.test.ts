import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Types } from 'mongoose';
import { connectDb } from '@pulse/db';
import { AccessDeniedError, type Centavos } from '@pulse/core';
import {
  PAYROLL_FISCAL_PLACEHOLDER_TEXT,
  PAYROLL_NO_BOARD_MESSAGE,
  PAYROLL_RECOMPUTED_AT_SUBMIT_MESSAGE,
  PAYROLL_REGISTER_NOT_AVAILABLE_TEXT,
  PAYROLL_RUN_CHANGED_MESSAGE,
  payrollYtdFiguresOf,
} from '../../payroll-run';
import { registerTalentApprovalTypes } from '../change-requests/service';
import { addCompensationEntry } from '../compensation/service';
import { registerTalentApprovalSigner, uploadESignature } from '../e-signatures/service';
import { EmployeeRecordModel } from '../employee-records/model';
import { saveOwnBankAccount } from '../employee-records/own';
import { setBankAccount, setGovernmentIds } from '../employee-records/service';
import { enterPayrollOpening } from '../opening-balances/service';
import { PayrollRunEmployeeModel, PayrollRunModel } from '../payroll-runs/model';
import {
  createPayrollDraftRun,
  getPayrollRunBreakdown,
  getPayrollRunView,
  PAYROLL_RUN_NOT_EDITABLE,
  recomputePayrollRun,
} from '../payroll-runs/service';
import { canOpenPayslip, PAYROLL_SUBMIT_DENIED } from '../policy';
import {
  approvalRequest,
  approvedLeave,
  auditEntries,
  database,
  decide,
  type Department,
  department,
  moveTo,
  notifications,
  type Person,
  person,
  pngFile,
  rawAuditJson,
  seedPayrollSettings,
  setLeaveSettings,
  setPositionType,
  setReportingTo,
  storedReimbursement,
  withoutIdsAndDates,
} from '../testing/fixtures';
import { TimeEntryModel, TimesheetModel } from '../timesheets/model';
import { createTimeEntry, getOwnTimesheetView } from '../timesheets/service';
import { submitTimesheet } from '../timesheets/submission';
import { acknowledgePayrollFlag } from './acknowledgements';
import { getPayrollRunApproverView, PAYROLL_AMOUNTS_APPROVER_DENIED } from './board-view';
import { PAYSLIP_READY_EVENT } from './finalize';
import { addPayrollManualEntry } from './manual';
import { PayrollFlagAcknowledgementModel, PayrollManualEntryModel } from './model';
import { getPayslip } from './payslip';
import { getPayrollRegister } from './register';
import { submitPayrollRun } from './submit';

// The payroll approval tests (docs/TESTING.md#payroll-review-and-payslip-tests, build step 2.10,
// chunk C2; decisions 360–365 and 369–371 in docs/BUILD_PLAN.md), end to end on the database and
// through Core's real approvals engine: submitting in cut-off order with the recompute at submit
// (A8, A9), the flag, Board and access refusals (A6, A11), the Board's view and its audited "Show
// amounts" (A12), a return and a resubmit (A10), the approval that finalizes the run with frozen
// payslips and year-to-date (A1, A5), the locked run (A13), the register (A16) and the Fiscal
// placeholder (A18), with no amount or account number in any audit entry, notification or approval
// request. Step 2.9's people and figures (P1 net ₱11,595.20, P2 net ₱11,092.74); made-up data
// only (HANDOFF item 318).

const pesos = (amount: number): Centavos => Math.round(amount * 100);
const at = (iso: string) => new Date(iso);
const TODAY = '2026-10-19T10:00:00+08:00';

const IDS = {
  tin: '900123456781',
  sss: '0498765432',
  philhealth: '120987654329',
  pagibig: '121234567893',
  rdoCode: '043',
};
const ACCOUNT_A = '0009876543217';
const ACCOUNT_B = '0001234567895';

let storageDir: string;
let NET: Department;
let OFF: Department;
let HRD: Department;
let ACC: Department;
let BOD: Department;
let hr: Person; // Ana
let hr2: Person; // another HR user, no Talent access
let accountant: Person; // Dan
let ben: Person;
let carla: Person;
let erin: Person;
let boss: Person;
let A: Person; // P1, UnionBank verified; timesheet approved only after the draft (A9)
let B: Person; // P2, RCBC entered but not verified (A6); a 2026 opening entry (A5)
let runId: string;
let laterRunId: string;

function setNow(iso: string = TODAY) {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(at(iso));
}

beforeEach(() => setNow());
afterEach(() => {
  vi.useRealTimers();
});

async function recordVersion(who: Person): Promise<number> {
  const record = await EmployeeRecordModel.findOne({
    employeeId: new Types.ObjectId(who.employeeId),
  }).lean();
  return record?.version ?? 0;
}

let count = 0;
async function employee(dept: Department, amount: number): Promise<Person> {
  count += 1;
  const p = await person('Test', `Payee${count}`, dept, { dateHired: '2025-01-01' });
  await setReportingTo(p, [boss]);
  const saved = await addCompensationEntry(hr.actor, {
    employeeId: p.employeeId,
    effectiveDate: '2025-01-01',
    basicSalaryCentavos: pesos(amount),
    rateType: 'monthly',
    minimumWageEarner: false,
    reason: 'Made-up test salary',
  });
  if (saved.status === 'belowMinimumWage') throw new Error('Salary not saved.');
  return p;
}

const entryOf = (p: Person, date: string, timeIn: string, timeOut: string, marked = false) =>
  createTimeEntry(p.actor, {
    date,
    timeIn,
    timeOut,
    activity: 'Made-up work',
    clientId: null,
    extraHoursReason: marked ? 'Network cutover for a client' : null,
  });

async function timesheetOf(p: Person, cutOff: string): Promise<string> {
  const view = await getOwnTimesheetView(p.actor, { cutOff });
  if (!view?.timesheet.id) throw new Error('No timesheet.');
  return view.timesheet.id;
}

async function approveTimesheet(p: Person, cutOff: string): Promise<void> {
  const { approvalRequestId } = await submitTimesheet(p.actor, {
    timesheetId: await timesheetOf(p, cutOff),
  });
  await decide(boss.actor, approvalRequestId, 'approve');
  await decide(hr.actor, approvalRequestId, 'approve');
}

/** The run's own audit entries, oldest first. */
async function runAudit() {
  return (await auditEntries('talent.payrollRun')).filter(
    (entry) => entry.record?.id?.toHexString() === runId,
  );
}

async function run() {
  const found = await PayrollRunModel.findById(runId).lean();
  if (!found) throw new Error('No run.');
  return found;
}

async function lineIdOf(p: Person, of = runId): Promise<string> {
  const line = await PayrollRunEmployeeModel.findOne({
    runId: new Types.ObjectId(of),
    employeeId: new Types.ObjectId(p.employeeId),
  }).lean();
  if (!line) throw new Error('No line.');
  return line._id.toHexString();
}

const submit = async (who: Person = hr, id: string = runId) =>
  submitPayrollRun(who.actor, {
    runId: id,
    version: (await PayrollRunModel.findById(id).lean())?.version ?? 0,
  });

/** Every stored notification, audit entry and approval request, ids and dates removed. */
async function storedText(): Promise<string> {
  const [notes, requests] = await Promise.all([
    database().collection('notifications').find({}).toArray(),
    database().collection('approvalRequests').find({}).toArray(),
  ]);
  return withoutIdsAndDates(
    `${await rawAuditJson()}${JSON.stringify(notes)}${JSON.stringify(requests)}`,
  );
}

beforeAll(async () => {
  storageDir = await mkdtemp(path.join(tmpdir(), 'pulse-test-storage-'));
  process.env.FILE_STORAGE_DIR = storageDir;
  await connectDb();
  await Promise.all([
    TimesheetModel.init(),
    TimeEntryModel.init(),
    PayrollRunModel.init(),
    PayrollRunEmployeeModel.init(),
    PayrollManualEntryModel.init(),
    PayrollFlagAcknowledgementModel.init(),
  ]);
  await seedPayrollSettings();
  NET = await department('Network', 'NET');
  OFF = await department('Office', 'OFF');
  await setPositionType(OFF, 'standard');
  HRD = await department('Human Resource', 'HR');
  ACC = await department('Accounting', 'ACCT');
  BOD = await department('Board of Directors', 'BOD');
  hr = await person('Ana', 'Reyes', HRD, { talent: 'write' });
  hr2 = await person('Hana', 'Uy', HRD);
  accountant = await person('Dan', 'Cruz', ACC, { talent: 'read' });
  ben = await person('Ben', 'Lim', BOD);
  carla = await person('Carla', 'Go', BOD);
  erin = await person('Erin', 'Sy', NET);
  boss = await person('Bea', 'Tan', NET);
  for (const approver of [hr, boss, ben, carla]) {
    await uploadESignature(approver.actor, pngFile());
  }
  registerTalentApprovalSigner();
  registerTalentApprovalTypes();

  setNow();
  await setLeaveSettings({ goLiveDate: '2026-09-26' });
  A = await employee(NET, 21750);
  B = await employee(OFF, 26100);
  for (const [who, bank, number] of [
    [A, 'unionbank', ACCOUNT_A],
    [B, 'rcbc', ACCOUNT_B],
  ] as const) {
    await setGovernmentIds(hr.actor, {
      employeeId: who.employeeId,
      version: await recordVersion(who),
      ...IDS,
    });
    if (who === A) {
      await setBankAccount(hr.actor, {
        employeeId: who.employeeId,
        version: await recordVersion(who),
        bank,
        accountNumber: number,
        accountName: `${who.firstName} ${who.lastName}`,
      });
    } else {
      await saveOwnBankAccount(who.actor, {
        version: await recordVersion(who),
        bank,
        accountNumber: number,
        accountName: `${who.firstName} ${who.lastName}`,
      });
    }
  }
  // A5: P2's year-to-date pay before go-live (made-up figures).
  await enterPayrollOpening(hr.actor, {
    employeeId: B.employeeId,
    grossCentavos: pesos(200000),
    basicSalaryEarnedCentavos: pesos(180000),
    taxableCompensationCentavos: pesos(190000),
    taxWithheldCentavos: pesos(9000),
    sssEmployeeCentavos: pesos(5250),
    philhealthEmployeeCentavos: pesos(2500),
    pagibigEmployeeCentavos: pesos(900),
  });

  // P1: Overtime timesheet, Sep 26 – Oct 10 (its reimbursement is added after the draft, in A9).
  await entryOf(A, '2026-09-28', '08:00', '19:00', true);
  for (const day of ['2026-09-29', '2026-09-30']) await entryOf(A, day, '08:00', '17:00');
  await entryOf(A, '2026-10-01', '08:30', '17:00');
  await entryOf(A, '2026-10-03', '08:00', '12:00', true);
  await entryOf(A, '2026-10-05', '08:00', '17:00');
  await entryOf(A, '2026-10-06', '08:00', '23:00', true);
  for (const day of ['2026-10-07', '2026-10-08', '2026-10-09']) {
    await entryOf(A, day, '08:00', '17:00');
  }
  // P2: Standard timesheet, approved VL Oct 8 – 9 with one day paid.
  await entryOf(B, '2026-09-28', '08:00', '17:00');
  await entryOf(B, '2026-09-29', '08:00', '19:00', true);
  await entryOf(B, '2026-09-30', '08:00', '16:00');
  for (const day of ['2026-10-01', '2026-10-02', '2026-10-05', '2026-10-06', '2026-10-07']) {
    await entryOf(B, day, '08:00', '17:00');
  }
  await entryOf(B, '2026-10-03', '08:00', '12:00', true);
  await approvedLeave(B, 'vacation', '2026-10-08', '2026-10-09', 2);
  for (const p of [A, B]) await approveTimesheet(p, '2026-09-26');

  runId = (await createPayrollDraftRun(hr.actor, { periodStart: '2026-09-26' })).id;
  vi.useRealTimers();
});

afterAll(async () => {
  await rm(storageDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------------------------

describe('submitting', () => {
  it('needs Talent Write and HR or the System Administrator, and the page’s version', async () => {
    for (const who of [accountant, ben]) {
      await expect(submit(who)).rejects.toThrow(AccessDeniedError);
      await expect(submit(who)).rejects.toThrow(PAYROLL_SUBMIT_DENIED);
    }
    const { version } = await run();
    await expect(submitPayrollRun(hr.actor, { runId, version: version - 1 })).rejects.toThrow(
      PAYROLL_RUN_CHANGED_MESSAGE,
    );
    expect((await run()).status).toBe('draft');
  });

  it('A6: refuses while a flag is neither resolved nor acknowledged', async () => {
    const before = await run();
    // P2's bank account isn't verified.
    await expect(submit()).rejects.toThrow('Resolve or acknowledge 1 flagged employee first.');
    const after = await run();
    expect(after.status).toBe('draft');
    expect(after.version).toBe(before.version);
    expect(after.approvalRequestId).toBeNull();
  });

  it('A9: keeps the recompute at submit and refuses when anything changed', async () => {
    setNow();
    // A reimbursement on P1's approved timesheet after the draft was computed.
    await storedReimbursement(A, await timesheetOf(A, '2026-09-26'), pesos(350), '2026-09-30');
    const before = await run();
    const reimbursementsBefore = await lineIdOf(A);
    await expect(submit()).rejects.toThrow(PAYROLL_RECOMPUTED_AT_SUBMIT_MESSAGE);
    const after = await run();
    expect(after.status).toBe('draft');
    expect(after.version).toBe(before.version + 1);
    expect((await runAudit()).at(-1)).toMatchObject({
      action: 'update',
      reason: 'Recomputed at submit',
      actorId: new Types.ObjectId(hr.userId),
    });
    // P1's line was replaced by the recompute, and now pays the reimbursement (step 2.9's P1).
    expect(await lineIdOf(A)).not.toBe(reimbursementsBefore);
    const view = await getPayrollRunView(accountant.actor, runId, { showAmounts: true });
    expect(view?.people.find((row) => row.employeeId === A.employeeId)?.netPayCentavos).toBe(
      pesos(11595.2),
    );
    // Nothing changed since: only P2's flag is left.
    await expect(submit()).rejects.toThrow('Resolve or acknowledge 1 flagged employee first.');
    expect((await run()).version).toBe(after.version);
  });

  it('A11: refuses when no Board member is active, changing nothing', async () => {
    setNow();
    await acknowledgePayrollFlag(hr.actor, {
      runId,
      employeeId: B.employeeId,
      flag: 'onboardingIncomplete',
      reason: 'Paid by check until the account is verified',
    });
    await moveTo(ben, NET);
    await moveTo(carla, NET);
    const before = await run();
    try {
      await expect(submit()).rejects.toThrow(PAYROLL_NO_BOARD_MESSAGE);
    } finally {
      await moveTo(ben, BOD);
      await moveTo(carla, BOD);
    }
    const after = await run();
    expect(after).toMatchObject({ status: 'draft', version: before.version, submittedAt: null });
    expect(await approvalRequestsFor(runId)).toBe(0);
  });

  it('A1: sends the run to the Board in counts only, and freezes it', async () => {
    setNow();
    const result = await submit();
    const pending = await run();
    expect(pending).toMatchObject({
      status: 'pendingApproval',
      submittedBy: new Types.ObjectId(hr.userId),
      version: result.version,
    });
    expect(pending.approvalRequestId?.toHexString()).toBe(result.approvalRequestId);
    const request = await approvalRequest(result.approvalRequestId);
    expect(request).toMatchObject({
      type: 'talent.payrollRun',
      title: 'Payroll · Sep 26 – Oct 10, 2026',
      summary: '2 employees · 0 manual entries · 1 flag acknowledged · pay date Oct 15, 2026',
      href: `/talent/payroll/${runId}`,
      record: { type: 'talent.payrollRun', label: pending.number },
      status: 'pending',
    });
    const approvers = (request?.pendingApproverIds as Types.ObjectId[]).map((id) =>
      id.toHexString(),
    );
    expect(approvers.sort()).toEqual([ben.userId, carla.userId].sort());
    expect((await runAudit()).at(-1)).toMatchObject({
      action: 'update',
      reason: 'Submitted for approval',
    });

    // Frozen: no recompute, manual entry, acknowledgement or second submit.
    await expect(recomputePayrollRun(hr.actor, { runId })).rejects.toThrow(
      PAYROLL_RUN_NOT_EDITABLE,
    );
    await expect(
      addPayrollManualEntry(hr.actor, {
        runId,
        employeeId: A.employeeId,
        kind: 'earning',
        label: 'Correction',
        amountCentavos: pesos(100),
        taxable: true,
        countsAsBasicSalary: false,
        reason: 'Made-up correction',
      }),
    ).rejects.toThrow(PAYROLL_RUN_NOT_EDITABLE);
    await expect(submit()).rejects.toThrow(PAYROLL_RUN_NOT_EDITABLE);
    // The register isn't available yet.
    expect(await getPayrollRegister(accountant.actor, runId, { show: true })).toMatchObject({
      available: false,
      unavailableMessage: PAYROLL_REGISTER_NOT_AVAILABLE_TEXT,
      shown: false,
      groups: [],
    });
    expect(
      (await runAudit()).some((entry) =>
        (entry.fields as string[] | undefined)?.includes('register'),
      ),
    ).toBe(false);
  });

  it('A8: refuses a later run while an earlier cut-off isn’t finalized', async () => {
    setNow('2026-11-12T10:00:00+08:00');
    laterRunId = (await createPayrollDraftRun(hr.actor, { periodStart: '2026-10-26' })).id;
    const { number } = await run();
    await expect(submit(hr, laterRunId)).rejects.toThrow(
      `Finalize Sep 26 – Oct 10, 2026 (${number}) first.`,
    );
    expect((await PayrollRunModel.findById(laterRunId).lean())?.status).toBe('draft');
  });
});

async function approvalRequestsFor(id: string): Promise<number> {
  return database()
    .collection('approvalRequests')
    .countDocuments({ 'record.id': new Types.ObjectId(id) });
}

describe('the Board’s view while approving (A12)', () => {
  it('shows the run read-only, and amounts only after the audited reveal', async () => {
    const plain = await getPayrollRunApproverView(ben.actor, runId);
    expect(plain).toMatchObject({
      status: 'pendingApproval',
      amountsShown: false,
      totals: null,
      canRecompute: false,
      canAcknowledge: false,
      approver: { pending: true, canShowAmounts: true },
    });
    expect(plain?.approver.approvalHref).toBe(
      `/approvals?request=${(await run()).approvalRequestId?.toHexString()}`,
    );
    expect(plain?.people.every((row) => row.netPayCentavos === null)).toBe(true);
    expect(plain?.people.every((row) => !row.canEnterManualEntries)).toBe(true);
    const flagged = plain?.people.find((row) => row.employeeId === B.employeeId);
    expect(flagged?.flags[0]?.acknowledgement?.text).toBe(
      'Acknowledged: Paid by check until the account is verified',
    );

    const reveals = async () =>
      (await runAudit()).filter(
        (entry) =>
          entry.action === 'reveal' &&
          entry.actorId?.toHexString() === ben.userId &&
          (entry.fields as string[]).includes('amounts'),
      ).length;
    expect(await reveals()).toBe(0);
    const shown = await getPayrollRunApproverView(ben.actor, runId, { showAmounts: true });
    expect(await reveals()).toBe(1);
    expect(shown?.totals?.netPayCentavos).toBe(pesos(22687.94));
    const net = (p: Person) =>
      shown?.people.find((row) => row.employeeId === p.employeeId)?.netPayCentavos;
    expect(net(A)).toBe(pesos(11595.2));
    expect(net(B)).toBe(pesos(11092.74));

    // Never a breakdown, the register or another view's amounts.
    await expect(getPayrollRunBreakdown(ben.actor, await lineIdOf(A))).rejects.toThrow(
      AccessDeniedError,
    );
    await expect(getPayrollRegister(ben.actor, runId)).rejects.toThrow(AccessDeniedError);
    await expect(getPayrollRunView(ben.actor, runId)).rejects.toThrow(AccessDeniedError);
  });

  it('gives no access to someone moved into the Board after the submit, nor to others', async () => {
    await moveTo(erin, BOD);
    try {
      await expect(getPayrollRunApproverView(erin.actor, runId)).rejects.toThrow(AccessDeniedError);
      await expect(
        getPayrollRunApproverView(erin.actor, runId, { showAmounts: true }),
      ).rejects.toThrow(AccessDeniedError);
    } finally {
      await moveTo(erin, NET);
    }
    await expect(getPayrollRunApproverView(accountant.actor, runId)).rejects.toThrow(
      AccessDeniedError,
    );
    expect(
      (await runAudit()).filter(
        (entry) => entry.action === 'reveal' && entry.actorId?.toHexString() === erin.userId,
      ),
    ).toHaveLength(0);
  });
});

describe('returning and resubmitting (A10)', () => {
  it('returns with remarks to HR, then the new request names the old one', async () => {
    setNow();
    const first = (await run()).approvalRequestId?.toHexString() ?? '';
    await decide(ben.actor, first, 'return', 'Check the cash advance');
    const returned = await run();
    expect(returned).toMatchObject({
      status: 'returned',
      returnedBy: new Types.ObjectId(ben.userId),
      returnRemarks: 'Check the cash advance',
    });
    expect((await runAudit()).at(-1)).toMatchObject({
      action: 'update',
      reason: 'Check the cash advance',
      actorId: new Types.ObjectId(ben.userId),
    });
    const outcome = await notifications({ event: 'core.approvalReturned' });
    expect(outcome.map((row) => row.recipientUserId.toHexString()).sort()).toEqual(
      [hr.userId, hr2.userId].sort(),
    );
    const view = await getPayrollRunView(hr.actor, runId);
    expect(view).toMatchObject({ status: 'returned', returnRemarks: 'Check the cash advance' });

    // Ben's part has ended: read-only, no amounts.
    const after = await getPayrollRunApproverView(ben.actor, runId);
    expect(after?.approver).toMatchObject({ pending: false, canShowAmounts: false });
    await expect(
      getPayrollRunApproverView(ben.actor, runId, { showAmounts: true }),
    ).rejects.toThrow(PAYROLL_AMOUNTS_APPROVER_DENIED);

    const again = await submit();
    expect((await approvalRequest(again.approvalRequestId))?.previousRequestId?.toHexString()).toBe(
      first,
    );
    expect((await run()).status).toBe('pendingApproval');
  });
});

describe('approving finalizes the run (A1, A5, A13, A16, A18)', () => {
  it('A1: Ben approves; the run is locked with frozen payslips and year-to-date', async () => {
    setNow();
    const requestId = (await run()).approvalRequestId?.toHexString() ?? '';
    await decide(ben.actor, requestId, 'approve');
    const finalized = await run();
    expect(finalized).toMatchObject({
      status: 'finalized',
      finalizedBy: new Types.ObjectId(ben.userId),
      fiscalPosting: { status: 'notPosted' },
      payslipsPending: true,
    });
    expect((await runAudit()).at(-1)).toMatchObject({
      action: 'update',
      reason: 'Finalized',
      actorId: new Types.ObjectId(ben.userId),
    });

    const p1 = await getPayslip(await lineIdOf(A));
    expect(p1?.view).toMatchObject({
      title: `Payslip ${finalized.number}`,
      periodText: 'Sep 26 – Oct 10, 2026',
      payDateText: 'Oct 15, 2026',
      grossCentavos: pesos(13637.5),
      deductionsCentavos: pesos(2042.3),
      netPayCentavos: pesos(11595.2),
      creditedText: 'Credited to UnionBank ending 3217',
      yearToDate: {
        grossCentavos: pesos(13637.5),
        taxWithheldCentavos: pesos(57.92),
        contributionsCentavos: pesos(921.88),
      },
    });
    expect(p1?.snapshot).toMatchObject({
      employeeName: `${A.firstName} ${A.lastName}`,
      employeeNumber: A.employeeNumber,
      departmentName: 'Network',
      bank: { bank: 'unionbank', accountNumberLastFour: '3217' },
    });
    expect(p1?.fileId).toBeNull();
    // The same payslip by run and employee.
    expect((await getPayslip({ runId, employeeId: A.employeeId }))?.lineId).toBe(p1?.lineId);

    // A5: P2's year-to-date adds the 2026 opening entry.
    const p2 = await getPayslip(await lineIdOf(B));
    const own = payrollYtdFiguresOf(p2?.breakdown ?? (undefined as never));
    expect(p2?.yearToDate).toEqual({
      grossCentavos: pesos(200000) + own.grossCentavos,
      taxWithheldCentavos: pesos(9000) + own.taxWithheldCentavos,
      sssEmployeeCentavos: pesos(5250) + own.sssEmployeeCentavos,
      philhealthEmployeeCentavos: pesos(2500) + own.philhealthEmployeeCentavos,
      pagibigEmployeeCentavos: pesos(900) + own.pagibigEmployeeCentavos,
      contributionsCentavos:
        pesos(8650) +
        own.sssEmployeeCentavos +
        own.philhealthEmployeeCentavos +
        own.pagibigEmployeeCentavos,
    });
    expect(p2?.view.netPayCentavos).toBe(pesos(11092.74));
    expect(p2?.view.creditedText).toBe('Credited to RCBC ending 7895');

    // Notifications: each employee's payslip, HR's outcome, Carla's "settled".
    const ready = await notifications({ event: PAYSLIP_READY_EVENT });
    expect(ready.map((row) => row.recipientUserId.toHexString()).sort()).toEqual(
      [A.userId, B.userId].sort(),
    );
    expect(ready[0]).toMatchObject({
      title: 'Your payslip for Sep 26 – Oct 10 is ready',
      href: '/talent/me#payslips',
      module: 'talent',
    });
    expect(ready.map((row) => row.dedupeKey).sort()).toEqual(
      [
        `talent.payslipReady:${await lineIdOf(A)}`,
        `talent.payslipReady:${await lineIdOf(B)}`,
      ].sort(),
    );
    const approved = await notifications({
      event: 'core.approvalApproved',
      title: 'Approved: Payroll · Sep 26 – Oct 10, 2026',
    });
    expect(approved.map((row) => row.recipientUserId.toHexString()).sort()).toEqual(
      [hr.userId, hr2.userId].sort(),
    );
    const settled = await notifications({ event: 'core.approvalSettled' });
    expect(settled.some((row) => row.recipientUserId.toHexString() === carla.userId)).toBe(true);
    expect(settled.find((row) => row.recipientUserId.toHexString() === carla.userId)?.title).toBe(
      'Settled by Ben Lim, no action needed',
    );
  });

  it('A13: a finalized run is locked', async () => {
    await expect(recomputePayrollRun(hr.actor, { runId })).rejects.toThrow(
      PAYROLL_RUN_NOT_EDITABLE,
    );
    await expect(
      acknowledgePayrollFlag(hr.actor, {
        runId,
        employeeId: B.employeeId,
        flag: 'onboardingIncomplete',
        reason: 'Again',
      }),
    ).rejects.toThrow(PAYROLL_RUN_NOT_EDITABLE);
    await expect(submit()).rejects.toThrow(PAYROLL_RUN_NOT_EDITABLE);
    // The snapshot is set once.
    const { version } = await run();
    await expect(
      PayrollRunModel.updateOne(
        { _id: new Types.ObjectId(runId), status: 'finalized' },
        { $set: { employeeCount: 9 } },
      ),
    ).rejects.toThrow();
    expect((await run()).version).toBe(version);
  });

  it('A16: the register shows bank details and net pay only after the reveal', async () => {
    const plain = await getPayrollRegister(accountant.actor, runId);
    expect(plain).toMatchObject({ available: true, shown: false, totalNetPayCentavos: null });
    expect(plain?.groups.map((group) => [group.label, group.count, group.rows.length])).toEqual([
      ['UnionBank', 1, 0],
      ['RCBC', 1, 0],
    ]);
    expect(JSON.stringify(plain)).not.toContain(ACCOUNT_A);

    const registerReveals = async () =>
      (await runAudit()).filter((entry) =>
        (entry.fields as string[] | undefined)?.includes('register'),
      ).length;
    expect(await registerReveals()).toBe(0);
    const shown = await getPayrollRegister(accountant.actor, runId, { show: true });
    expect(await registerReveals()).toBe(1);
    expect(shown?.totalNetPayCentavos).toBe(pesos(22687.94));
    expect(
      shown?.groups.map((group) => [group.label, group.count, group.totalNetPayCentavos]),
    ).toEqual([
      ['UnionBank', 1, pesos(11595.2)],
      ['RCBC', 1, pesos(11092.74)],
    ]);
    expect(shown?.groups[0]?.rows[0]).toMatchObject({
      employeeId: A.employeeId,
      employeeNumber: A.employeeNumber,
      bankLabel: 'UnionBank',
      accountNumber: ACCOUNT_A,
      netPayCentavos: pesos(11595.2),
    });
    // HR may see it too; a Board member never.
    expect((await getPayrollRegister(hr.actor, runId))?.available).toBe(true);
    await expect(getPayrollRegister(ben.actor, runId, { show: true })).rejects.toThrow(
      AccessDeniedError,
    );
  });

  it('A18: the Fiscal posting placeholder; the Board’s view after deciding has no amounts', async () => {
    const view = await getPayrollRunView(accountant.actor, runId);
    expect(view).toMatchObject({
      status: 'finalized',
      fiscalPostingStatus: 'notPosted',
      finalizedByName: 'Ben Lim',
      payslipsPending: true,
    });
    expect(PAYROLL_FISCAL_PLACEHOLDER_TEXT).toBe(
      'Pulse Fiscal posting: waiting for Pulse Fiscal (Phase 5).',
    );
    const board = await getPayrollRunApproverView(carla.actor, runId);
    expect(board?.approver.pending).toBe(false);
    await expect(
      getPayrollRunApproverView(carla.actor, runId, { showAmounts: true }),
    ).rejects.toThrow(PAYROLL_AMOUNTS_APPROVER_DENIED);
  });

  it('who may open a payslip, and none before finalizing', async () => {
    expect(canOpenPayslip(A.actor, A.employeeId)).toBe(true);
    expect(canOpenPayslip(B.actor, A.employeeId)).toBe(false);
    expect(canOpenPayslip(accountant.actor, A.employeeId)).toBe(true);
    expect(canOpenPayslip(hr.actor, A.employeeId)).toBe(true);
    expect(canOpenPayslip(ben.actor, A.employeeId)).toBe(false);
    expect(canOpenPayslip(boss.actor, A.employeeId)).toBe(false);
    expect(await getPayslip({ runId: laterRunId, employeeId: A.employeeId })).toBeNull();
    expect(await getPayslip('not-an-id')).toBeNull();
  });

  it('then the later run is refused until the cut-off between is computed and finalized', async () => {
    setNow('2026-11-12T10:00:00+08:00');
    await expect(submit(hr, laterRunId)).rejects.toThrow(
      'Compute and finalize the run for Oct 11 – 25, 2026 first.',
    );
  });

  it('holds no amount or account number in any audit entry, notification or request', async () => {
    const text = await storedText();
    for (const secret of [
      ACCOUNT_A,
      ACCOUNT_B,
      '3217',
      String(pesos(11595.2)),
      String(pesos(11092.74)),
      String(pesos(22687.94)),
      String(pesos(13637.5)),
      '11,595',
      '22,687',
    ]) {
      expect(text).not.toContain(secret);
    }
  });
});
