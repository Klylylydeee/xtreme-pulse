import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { Types } from 'mongoose';
import { connectDb } from '@pulse/db';
import { AccessDeniedError, type Centavos } from '@pulse/core';
import {
  PAYROLL_AUTHORIZATION_REQUIRED_MESSAGE,
  PAYROLL_FLAG_NOT_ACKNOWLEDGEABLE_MESSAGE,
  PAYROLL_OVERRIDE_ATTENDANCE_MESSAGE,
  type PayrollBreakdown,
} from '../../payroll-run';
import { registerTalentApprovalTypes } from '../change-requests/service';
import { addCompensationEntry } from '../compensation/service';
import { registerTalentApprovalSigner, uploadESignature } from '../e-signatures/service';
import { EmployeeRecordModel } from '../employee-records/model';
import { saveOwnBankAccount } from '../employee-records/own';
import { markVerified, setBankAccount, setGovernmentIds } from '../employee-records/service';
import { runPayrollDrafts } from '../payroll-runs/job';
import { PayrollRunEmployeeModel, PayrollRunModel } from '../payroll-runs/model';
import {
  createPayrollDraftRun,
  getPayrollRunBreakdown,
  getPayrollRunView,
  PAYROLL_RUN_NOT_EDITABLE,
  recomputePayrollRun,
} from '../payroll-runs/service';
import {
  PAYROLL_MANUAL_ENTRY_DENIED,
  PAYROLL_MANUAL_ENTRY_HR_DENIED,
  PAYROLL_MANUAL_ENTRY_OWN_DENIED,
} from '../policy';
import {
  approvedLeave,
  auditEntries,
  database,
  decide,
  type Department,
  department,
  type Person,
  person,
  pngFile,
  rawAuditJson,
  seedPayrollSettings,
  setLeaveSettings,
  setPositionType,
  setReportingTo,
  setRunStatus,
  storedReimbursement,
  withoutIdsAndDates,
} from '../testing/fixtures';
import { TimeEntryModel, TimesheetModel } from '../timesheets/model';
import { createTimeEntry, getOwnTimesheetView } from '../timesheets/service';
import { submitTimesheet } from '../timesheets/submission';
import {
  acknowledgeAllPayrollFlag,
  acknowledgePayrollFlag,
  PAYROLL_FLAG_ALREADY_ACKNOWLEDGED,
  PAYROLL_FLAG_NOT_ON_LINE,
  payrollRunUnresolvedFlags,
} from './acknowledgements';
import {
  addPayrollManualEntry,
  editPayrollManualEntry,
  PAYROLL_MANUAL_ENTRY_CHANGED,
  PAYROLL_MANUAL_RECOMPUTE_REASON,
  PAYROLL_OVERRIDE_EXISTS,
  removePayrollManualEntry,
} from './manual';
import { PayrollFlagAcknowledgementModel, PayrollManualEntryModel } from './model';

// The payroll review tests (docs/TESTING.md#payroll-review-and-payslip-tests, build step 2.10,
// chunk C1; decisions 351–359 in docs/BUILD_PLAN.md), end to end on the database: the review
// flags stored by each compute (onboarding incomplete, timesheet not approved, net pay below
// zero), acknowledging them (A6, A7), manual entries with their recompute, chain and audit (A2,
// A3, A4, A7), who may enter them (A17), a returned run edited like a draft and a pending or
// finalized run frozen (the service, the job), and no amount in any audit entry. Step 2.9's people
// and figures (P1 net ₱11,595.20, P2 net ₱11,092.74); made-up data only (HANDOFF item 318).

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
const ACCOUNT_NUMBER = '0009876543217';

let storageDir: string;
let NET: Department;
let OFF: Department;
let HRD: Department;
let ACC: Department;
let BOD: Department;
let hr: Person;
let accountant: Person;
let board: Person;
let admin: Person;
let boss: Person;
let A: Person; // P1
let B: Person; // P2, bank account not verified (A6)
let H: Person; // HR staff with a salary (A17), Talent Write
let runId: string;

function setNow(iso: string = TODAY) {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(at(iso));
}

afterEach(() => {
  vi.useRealTimers();
});

async function recordVersion(who: Person): Promise<number> {
  const record = await EmployeeRecordModel.findOne({
    employeeId: new Types.ObjectId(who.employeeId),
  }).lean();
  return record?.version ?? 0;
}

/** Government IDs entered and verified, and the bank account entered (verified by default). */
async function payrollReady(
  who: Person,
  by: Person,
  { bankVerified = true }: { bankVerified?: boolean } = {},
): Promise<void> {
  await setGovernmentIds(by.actor, {
    employeeId: who.employeeId,
    version: await recordVersion(who),
    ...IDS,
  });
  if (bankVerified) {
    await setBankAccount(by.actor, {
      employeeId: who.employeeId,
      version: await recordVersion(who),
      bank: 'unionbank',
      accountNumber: ACCOUNT_NUMBER,
      accountName: `${who.firstName} ${who.lastName}`,
    });
  } else {
    await saveOwnBankAccount(who.actor, {
      version: await recordVersion(who),
      bank: 'rcbc',
      accountNumber: ACCOUNT_NUMBER,
      accountName: `${who.firstName} ${who.lastName}`,
    });
  }
}

let count = 0;
async function employee(
  dept: Department,
  amount: number,
  by: Person,
  options: { talent?: 'none' | 'write' } = {},
): Promise<Person> {
  count += 1;
  const p = await person('Test', `Payee${count}`, dept, {
    dateHired: '2025-01-01',
    talent: options.talent ?? 'none',
  });
  await setReportingTo(p, [boss]);
  const saved = await addCompensationEntry(by.actor, {
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

async function approve(p: Person, cutOff: string): Promise<void> {
  const { approvalRequestId } = await submitTimesheet(p.actor, {
    timesheetId: await timesheetOf(p, cutOff),
  });
  await decide(boss.actor, approvalRequestId, 'approve');
  await decide(hr.actor, approvalRequestId, 'approve');
}

async function lineOf(p: Person) {
  const line = await PayrollRunEmployeeModel.findOne({
    runId: new Types.ObjectId(runId),
    employeeId: new Types.ObjectId(p.employeeId),
  }).lean();
  if (!line) throw new Error('No line.');
  return line;
}

async function breakdownOf(p: Person): Promise<PayrollBreakdown> {
  const line = await lineOf(p);
  const view = await getPayrollRunBreakdown(hr.actor, line._id.toHexString());
  if (!view) throw new Error('No breakdown.');
  return view.breakdown;
}

const amountOf = (b: PayrollBreakdown, key: string) =>
  b.lines.find((line) => line.key === key && line.group !== 'settlements')?.amountCentavos;

const flagKinds = async (p: Person) => (await lineOf(p)).flags.map((flag) => flag.kind);

async function runVersion(): Promise<number> {
  return (await PayrollRunModel.findById(runId).lean())?.version ?? 0;
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
  accountant = await person('Dan', 'Cruz', ACC, { talent: 'read' });
  board = await person('Ben', 'Lim', BOD, { talent: 'write' });
  admin = await person('Ada', 'Admin', NET, { admin: true });
  boss = await person('Bea', 'Tan', NET);
  for (const approver of [hr, boss]) await uploadESignature(approver.actor, pngFile());
  registerTalentApprovalSigner();
  registerTalentApprovalTypes();

  setNow();
  await setLeaveSettings({ goLiveDate: '2026-09-26' });
  A = await employee(NET, 21750, hr);
  B = await employee(OFF, 26100, hr);
  H = await employee(HRD, 21750, admin, { talent: 'write' });
  await payrollReady(A, hr);
  await payrollReady(B, hr, { bankVerified: false });

  // P1: Overtime timesheet, Sep 26 – Oct 10.
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
  for (const p of [A, B]) await approve(p, '2026-09-26');
  await storedReimbursement(A, await timesheetOf(A, '2026-09-26'), pesos(350), '2026-09-30');

  runId = (await createPayrollDraftRun(hr.actor, { periodStart: '2026-09-26' })).id;
  vi.useRealTimers();
});

afterAll(async () => {
  await rm(storageDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------------------------

describe('the review flags', () => {
  it('stores each line’s flags and the run’s counts, with step 2.9’s figures unchanged', async () => {
    const p1 = await breakdownOf(A);
    expect(p1.breakdownVersion).toBe(2);
    expect(p1.totals.netPayCentavos).toBe(pesos(11595.2));
    expect((await breakdownOf(B)).totals.netPayCentavos).toBe(pesos(11092.74));
    expect(await flagKinds(A)).toEqual([]);
    expect((await lineOf(B)).flags).toEqual([
      { kind: 'onboardingIncomplete', items: ['bankAccount:waitingForVerification'] },
    ]);
    expect(await flagKinds(H)).toEqual(['onboardingIncomplete', 'timesheetNotApproved']);
    const run = await PayrollRunModel.findById(runId).lean();
    expect(run?.flagCounts).toEqual({
      onboardingIncomplete: 2,
      timesheetNotApproved: 1,
      belowMinimumWage: 0,
      netPayBelowZero: 0,
      manualEntryStale: 0,
    });
    const view = await getPayrollRunView(hr.actor, runId);
    expect(view?.tiles).toMatchObject({
      employees: 3,
      onboardingIncomplete: 2,
      belowMinimumWage: 0,
      manualEntryStale: 0,
    });
    expect(view?.unresolvedFlaggedEmployees).toBe(2);
    expect(view?.canAcknowledge).toBe(true);
    const flag = view?.people.find((row) => row.employeeId === B.employeeId)?.flags[0];
    expect(flag).toMatchObject({
      text: 'Onboarding incomplete: payroll bank account not verified',
      acknowledgeable: true,
      acknowledgement: null,
      unresolved: true,
    });
  });
});

describe('manual entries', () => {
  it('A2: a taxable back pay counting as basic salary, then edited and removed', async () => {
    setNow();
    const version = await runVersion();
    const saved = await addPayrollManualEntry(hr.actor, {
      runId,
      employeeId: A.employeeId,
      kind: 'earning',
      label: 'Back pay: salary increase from Sep 15',
      amountCentavos: pesos(1000),
      taxable: true,
      countsAsBasicSalary: true,
      reason: 'Salary increase approved late',
    });
    expect(saved.version).toBe(version + 1);
    const p1 = await breakdownOf(A);
    expect(p1.totals).toMatchObject({
      grossCentavos: pesos(14637.5),
      deductionsCentavos: pesos(2192.3),
      netPayCentavos: pesos(12445.2),
    });
    expect(p1.taxableCompensationCentavos).toBe(pesos(11803.12));
    expect(amountOf(p1, 'withholdingTax')).toBe(pesos(207.92));
    expect(amountOf(p1, 'sssEmployee')).toBe(pesos(550));
    expect(amountOf(p1, `manual:${saved.entryId}`)).toBe(pesos(1000));
    expect((await lineOf(A)).manualEntryCount).toBe(1);

    // The audit: `create` on the entry with the reason and no amount; the run "recomputed".
    const entryAudit = await auditEntries('talent.payrollManualEntry');
    expect(entryAudit).toHaveLength(1);
    expect(entryAudit[0]).toMatchObject({
      action: 'create',
      reason: 'Salary increase approved late',
      actorId: new Types.ObjectId(hr.userId),
    });
    expect(entryAudit[0]?.record.label).toBe(
      `PAY-2026-0001 · ${A.employeeNumber} · Back pay: salary increase from Sep 15`,
    );
    const runAudit = await auditEntries('talent.payrollRun');
    expect(runAudit.at(-1)).toMatchObject({
      action: 'update',
      reason: PAYROLL_MANUAL_RECOMPUTE_REASON,
    });

    // The view: listed with no amount until "Show amounts".
    const plain = await getPayrollRunView(accountant.actor, runId);
    expect(plain?.manualEntries).toHaveLength(1);
    expect(plain?.manualEntries[0]).toMatchObject({
      kind: 'earning',
      label: 'Back pay: salary increase from Sep 15',
      reason: 'Salary increase approved late',
      enteredByName: 'Ana Reyes',
      amountCentavos: null,
      staleReason: null,
    });
    expect(plain?.manualEntryCount).toBe(1);
    const shown = await getPayrollRunView(accountant.actor, runId, { showAmounts: true });
    expect(shown?.manualEntries[0]?.amountCentavos).toBe(pesos(1000));

    // Edit: a new entry superseding it; the History keeps the old amount.
    const edited = await editPayrollManualEntry(hr.actor, {
      runId,
      entryId: saved.entryId,
      kind: 'earning',
      label: 'Back pay: salary increase from Sep 15',
      amountCentavos: pesos(2000),
      taxable: true,
      countsAsBasicSalary: true,
      reason: 'Corrected the days',
    });
    expect((await breakdownOf(A)).totals.grossCentavos).toBe(pesos(15637.5));
    const line = await lineOf(A);
    const sheet = await getPayrollRunBreakdown(hr.actor, line._id.toHexString());
    expect(sheet?.manualEntries).toHaveLength(1);
    expect(sheet?.manualEntries[0]).toMatchObject({
      id: edited.entryId,
      amountCentavos: pesos(2000),
      live: true,
      history: [expect.objectContaining({ id: saved.entryId, amountCentavos: pesos(1000) })],
    });
    expect(sheet?.canEnterManualEntries).toBe(true);
    // Editing the superseded entry again is refused.
    await expect(
      editPayrollManualEntry(hr.actor, {
        runId,
        entryId: saved.entryId,
        kind: 'earning',
        label: 'x',
        amountCentavos: pesos(1),
        taxable: true,
        countsAsBasicSalary: true,
        reason: 'Stale page',
      }),
    ).rejects.toThrow(PAYROLL_MANUAL_ENTRY_CHANGED);

    await removePayrollManualEntry(hr.actor, {
      runId,
      entryId: edited.entryId,
      reason: 'Paid in the next cut-off instead',
    });
    expect((await breakdownOf(A)).totals.netPayCentavos).toBe(pesos(11595.2));
    expect((await lineOf(A)).manualEntryCount).toBe(0);
    const actions = (await auditEntries('talent.payrollManualEntry')).map((entry) => [
      entry.action,
      entry.record.id.toHexString(),
    ]);
    // One record (the chain's first entry), three actions.
    expect(actions).toEqual([
      ['create', saved.entryId],
      ['update', saved.entryId],
      ['delete', saved.entryId],
    ]);
  });

  it('A3: an after-tax deduction needs the written authorization', async () => {
    setNow();
    const input = {
      runId,
      employeeId: B.employeeId,
      kind: 'deduction' as const,
      label: 'Cash advance',
      amountCentavos: pesos(500),
      reducesTaxablePay: false,
      countsAsBasicSalary: false,
      reason: 'Cash advance on Oct 1',
    };
    await expect(addPayrollManualEntry(hr.actor, input)).rejects.toThrow(
      PAYROLL_AUTHORIZATION_REQUIRED_MESSAGE,
    );
    const saved = await addPayrollManualEntry(hr.actor, { ...input, authorizedInWriting: true });
    const p2 = await breakdownOf(B);
    expect(p2.totals.netPayCentavos).toBe(pesos(10592.74));
    expect(p2.taxCentavos).toBe(pesos(31.01));
    await removePayrollManualEntry(hr.actor, { runId, entryId: saved.entryId, reason: 'Undo' });
  });

  it('A4: an override of the withholding tax; attendance items can’t be overridden', async () => {
    setNow();
    const saved = await addPayrollManualEntry(hr.actor, {
      runId,
      employeeId: A.employeeId,
      kind: 'override',
      targetLineKey: 'withholdingTax',
      amountCentavos: 0,
      reason: 'Tax already withheld by the previous employer',
    });
    const p1 = await breakdownOf(A);
    const tax = p1.lines.find((line) => line.key === 'withholdingTax');
    expect(tax).toMatchObject({
      amountCentavos: 0,
      override: { entryId: saved.entryId, computedAmountCentavos: pesos(57.92) },
    });
    expect(p1.totals.netPayCentavos).toBe(pesos(11653.12));
    const stored = await PayrollManualEntryModel.findById(saved.entryId).lean();
    expect(stored?.label).toBe('Withholding tax');

    await expect(
      addPayrollManualEntry(hr.actor, {
        runId,
        employeeId: A.employeeId,
        kind: 'override',
        targetLineKey: 'absence',
        amountCentavos: 0,
        reason: 'Excused',
      }),
    ).rejects.toThrow(PAYROLL_OVERRIDE_ATTENDANCE_MESSAGE);
    await expect(
      addPayrollManualEntry(hr.actor, {
        runId,
        employeeId: A.employeeId,
        kind: 'override',
        targetLineKey: 'withholdingTax',
        amountCentavos: pesos(10),
        reason: 'Twice',
      }),
    ).rejects.toThrow(PAYROLL_OVERRIDE_EXISTS);

    const line = await lineOf(A);
    const sheet = await getPayrollRunBreakdown(hr.actor, line._id.toHexString());
    expect(sheet?.overrideTargets.find((target) => target.key === 'withholdingTax')).toEqual({
      key: 'withholdingTax',
      label: 'Withholding tax',
      computedAmountCentavos: pesos(57.92),
      overridden: true,
    });
    expect(sheet?.overrideTargets.map((target) => target.key)).toContain('basicPay');
    expect(sheet?.overrideTargets.map((target) => target.key)).not.toContain('absence');
    const shown = await getPayrollRunView(hr.actor, runId, { showAmounts: true });
    expect(shown?.manualEntries[0]).toMatchObject({
      kind: 'override',
      amountCentavos: 0,
      computedAmountCentavos: pesos(57.92),
    });
    await removePayrollManualEntry(hr.actor, { runId, entryId: saved.entryId, reason: 'Undo' });
    expect((await breakdownOf(A)).totals.netPayCentavos).toBe(pesos(11595.2));
  });

  it('A7: net pay below zero can’t be acknowledged; a manual entry resolves it', async () => {
    setNow();
    const deduction = await addPayrollManualEntry(hr.actor, {
      runId,
      employeeId: A.employeeId,
      kind: 'deduction',
      label: 'Loan',
      amountCentavos: pesos(20000),
      reducesTaxablePay: false,
      authorizedInWriting: true,
      countsAsBasicSalary: false,
      reason: 'Company loan, signed authorization on file',
    });
    expect(await flagKinds(A)).toEqual(['netPayBelowZero']);
    expect((await PayrollRunModel.findById(runId).lean())?.flagCounts.netPayBelowZero).toBe(1);
    await expect(
      acknowledgePayrollFlag(hr.actor, {
        runId,
        employeeId: A.employeeId,
        flag: 'netPayBelowZero',
        reason: 'Will settle later',
      }),
    ).rejects.toThrow(PAYROLL_FLAG_NOT_ACKNOWLEDGEABLE_MESSAGE);
    let unresolved = await payrollRunUnresolvedFlags(runId);
    expect(unresolved.employees).toContainEqual({
      employeeId: A.employeeId,
      flags: ['netPayBelowZero'],
    });

    const moved = await addPayrollManualEntry(hr.actor, {
      runId,
      employeeId: A.employeeId,
      kind: 'earning',
      label: 'Deduction moved to next cut-off',
      amountCentavos: pesos(10000),
      taxable: false,
      countsAsBasicSalary: false,
      reason: 'Half of the loan moves to the next cut-off',
    });
    expect(await flagKinds(A)).toEqual([]);
    expect((await breakdownOf(A)).totals.netPayCentavos).toBe(pesos(1595.2));
    unresolved = await payrollRunUnresolvedFlags(runId);
    expect(unresolved.employees.map((row) => row.employeeId)).not.toContain(A.employeeId);
    for (const entry of [moved, deduction]) {
      await removePayrollManualEntry(hr.actor, { runId, entryId: entry.entryId, reason: 'Undo' });
    }
  });

  it('A17: HR staff’s entries by the System Administrator only; never one’s own line', async () => {
    setNow();
    const input = {
      runId,
      employeeId: H.employeeId,
      kind: 'earning' as const,
      label: 'Correction',
      amountCentavos: pesos(100),
      taxable: true,
      countsAsBasicSalary: false,
      reason: 'Correction of the last cut-off',
    };
    await expect(addPayrollManualEntry(hr.actor, input)).rejects.toThrow(
      PAYROLL_MANUAL_ENTRY_HR_DENIED,
    );
    await expect(addPayrollManualEntry(H.actor, input)).rejects.toThrow(
      PAYROLL_MANUAL_ENTRY_OWN_DENIED,
    );
    for (const reader of [accountant, board]) {
      await expect(
        addPayrollManualEntry(reader.actor, { ...input, employeeId: A.employeeId }),
      ).rejects.toBeInstanceOf(AccessDeniedError);
    }
    await expect(
      addPayrollManualEntry(board.actor, { ...input, employeeId: A.employeeId }),
    ).rejects.toThrow(PAYROLL_MANUAL_ENTRY_DENIED);
    const saved = await addPayrollManualEntry(admin.actor, input);
    expect((await lineOf(H)).manualEntryCount).toBe(1);
    const view = await getPayrollRunView(hr.actor, runId);
    expect(view?.people.find((row) => row.employeeId === H.employeeId)).toMatchObject({
      manualEntryCount: 1,
      canEnterManualEntries: false,
    });
    expect(view?.people.find((row) => row.employeeId === A.employeeId)?.canEnterManualEntries).toBe(
      true,
    );
    await removePayrollManualEntry(admin.actor, { runId, entryId: saved.entryId, reason: 'Undo' });
  });

  it('keeps every amount out of the audit log', async () => {
    const json = withoutIdsAndDates(await rawAuditJson());
    for (const amount of ['100000', '200000', '2000000', '1000000', '5792', '1244520']) {
      expect(json).not.toContain(`"${amount}"`);
      expect(json).not.toContain(`:${amount}`);
    }
    const created = (await auditEntries('talent.payrollManualEntry'))[0];
    expect(JSON.stringify(created?.after)).not.toMatch(/amountCentavos":\s*\d/);
  });
});

describe('acknowledging flags', () => {
  it('A6: acknowledges with a reason, once; verifying and recomputing clears the flag', async () => {
    setNow();
    await expect(
      acknowledgePayrollFlag(accountant.actor, {
        runId,
        employeeId: B.employeeId,
        flag: 'onboardingIncomplete',
        reason: 'x',
      }),
    ).rejects.toBeInstanceOf(AccessDeniedError);
    await expect(
      acknowledgePayrollFlag(hr.actor, {
        runId,
        employeeId: A.employeeId,
        flag: 'onboardingIncomplete',
        reason: 'Not flagged',
      }),
    ).rejects.toThrow(PAYROLL_FLAG_NOT_ON_LINE);
    const result = await acknowledgePayrollFlag(hr.actor, {
      runId,
      employeeId: B.employeeId,
      flag: 'onboardingIncomplete',
      reason: 'Paid by check; bank details to follow',
    });
    expect(result.acknowledged).toBe(1);
    await expect(
      acknowledgePayrollFlag(hr.actor, {
        runId,
        employeeId: B.employeeId,
        flag: 'onboardingIncomplete',
        reason: 'Again',
      }),
    ).rejects.toThrow(PAYROLL_FLAG_ALREADY_ACKNOWLEDGED);
    const audit = await auditEntries('talent.payrollRun');
    expect(audit.at(-1)).toMatchObject({
      action: 'update',
      reason: `Acknowledged onboarding incomplete for ${B.employeeNumber}: Paid by check; bank details to follow`,
    });
    let view = await getPayrollRunView(hr.actor, runId);
    expect(view?.people.find((row) => row.employeeId === B.employeeId)?.flags[0]).toMatchObject({
      acknowledgement: {
        reason: 'Paid by check; bank details to follow',
        text: 'Acknowledged: Paid by check; bank details to follow',
        byName: 'Ana Reyes',
      },
      unresolved: false,
    });
    expect(view?.unresolvedFlaggedEmployees).toBe(1);
    expect(view?.acknowledgedFlagCount).toBe(1);

    // "Acknowledge all" covers H's two flags, one kind at a time; HR acknowledges HR staff too.
    expect(
      (
        await acknowledgeAllPayrollFlag(hr.actor, {
          runId,
          flag: 'onboardingIncomplete',
          reason: 'IDs to follow',
        })
      ).acknowledged,
    ).toBe(1);
    await acknowledgeAllPayrollFlag(hr.actor, {
      runId,
      flag: 'timesheetNotApproved',
      reason: 'Basic pay only this cut-off',
    });
    expect((await payrollRunUnresolvedFlags(runId)).count).toBe(0);

    // The acknowledgement stays while the flag is on the line; verifying clears the flag.
    await markVerified(hr.actor, {
      employeeId: B.employeeId,
      version: await recordVersion(B),
      group: 'bankAccount',
    });
    await recomputePayrollRun(hr.actor, { runId });
    expect(await flagKinds(B)).toEqual([]);
    view = await getPayrollRunView(hr.actor, runId);
    expect(view?.acknowledgedFlagCount).toBe(2);
  });
});

describe('a returned run is edited like a draft; a pending or finalized run is frozen', () => {
  it('recomputes and takes entries while returned, and the job recomputes it', async () => {
    setNow();
    await setRunStatus(runId, 'returned');
    const before = await runVersion();
    await recomputePayrollRun(hr.actor, { runId });
    expect(await runVersion()).toBe(before + 1);
    const saved = await addPayrollManualEntry(hr.actor, {
      runId,
      employeeId: B.employeeId,
      kind: 'earning',
      label: 'Correction',
      amountCentavos: pesos(100),
      taxable: false,
      countsAsBasicSalary: false,
      reason: 'Fix after the Board returned it',
    });
    const job = await runPayrollDrafts(at('2026-10-19T05:00:00+08:00'));
    expect(job.recomputed).toBe(1);
    expect((await PayrollRunModel.findById(runId).lean())?.status).toBe('returned');
    await removePayrollManualEntry(hr.actor, { runId, entryId: saved.entryId, reason: 'Undo' });
  });

  it.each(['pendingApproval', 'finalized'] as const)(
    'refuses every change while %s',
    async (status) => {
      setNow();
      const entry = await addPayrollManualEntry(hr.actor, {
        runId: (await setRunStatus(runId, 'draft'), runId),
        employeeId: A.employeeId,
        kind: 'earning',
        label: 'Correction',
        amountCentavos: pesos(50),
        taxable: false,
        countsAsBasicSalary: false,
        reason: 'Before the submit',
      });
      await setRunStatus(runId, status);
      const version = await runVersion();
      await expect(recomputePayrollRun(hr.actor, { runId })).rejects.toThrow(
        PAYROLL_RUN_NOT_EDITABLE,
      );
      await expect(
        addPayrollManualEntry(hr.actor, {
          runId,
          employeeId: A.employeeId,
          kind: 'earning',
          label: 'Late',
          amountCentavos: pesos(50),
          taxable: false,
          countsAsBasicSalary: false,
          reason: 'Too late',
        }),
      ).rejects.toThrow(PAYROLL_RUN_NOT_EDITABLE);
      await expect(
        removePayrollManualEntry(hr.actor, { runId, entryId: entry.entryId, reason: 'Too late' }),
      ).rejects.toThrow(PAYROLL_RUN_NOT_EDITABLE);
      await expect(
        acknowledgeAllPayrollFlag(hr.actor, {
          runId,
          flag: 'timesheetNotApproved',
          reason: 'Too late',
        }),
      ).rejects.toThrow(PAYROLL_RUN_NOT_EDITABLE);
      const job = await runPayrollDrafts(at('2026-10-19T05:00:00+08:00'));
      expect(job.recomputed).toBe(0);
      expect(await runVersion()).toBe(version);
      const view = await getPayrollRunView(hr.actor, runId);
      expect(view).toMatchObject({ editable: false, canRecompute: false, canAcknowledge: false });
      expect(view?.people.every((row) => !row.canEnterManualEntries)).toBe(true);
      // Leave the run a draft without the entry for the next case.
      await setRunStatus(runId, 'draft');
      await removePayrollManualEntry(hr.actor, { runId, entryId: entry.entryId, reason: 'Undo' });
      expect(await database().collection('payrollRuns').countDocuments()).toBe(1);
    },
  );
});
