import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Types } from 'mongoose';
import { connectDb } from '@pulse/db';
import { AccessDeniedError, ActionError, type Centavos } from '@pulse/core';
import { openAccessibleFile, revealSensitiveField } from '@pulse/core/server';
import { coreSeedLoaders } from '@pulse/core/server/seed';
import { registerTalentApprovalTypes } from '../change-requests/service';
import { addCompensationEntry } from '../compensation/service';
import { registerTalentApprovalSigner, uploadESignature } from '../e-signatures/service';
import { EmployeeRecordModel } from '../employee-records/model';
import { setBankAccount, setGovernmentIds } from '../employee-records/service';
import { registerTalentFileAccess } from '../files/registrations';
import { PayrollFlagAcknowledgementModel, PayrollManualEntryModel } from '../payroll-review/model';
import { submitPayrollRun } from '../payroll-review/submit';
import { PayrollRunEmployeeModel, PayrollRunModel } from '../payroll-runs/model';
import { createPayrollDraftRun, getPayrollRunView } from '../payroll-runs/service';
import { registerTalentSensitiveReveals } from '../sensitive/reveals';
import {
  approvedLeave,
  auditEntries,
  currentUser,
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
  withoutIdsAndDates,
} from '../testing/fixtures';
import { TimeEntryModel, TimesheetModel } from '../timesheets/model';
import { createTimeEntry, getOwnTimesheetView } from '../timesheets/service';
import { submitTimesheet } from '../timesheets/submission';
import { runPayslipPdfs } from './job';
import {
  listOwnPayslips,
  loadPayslipCompany,
  openPayslipHref,
  PAYSLIP_FILE_TYPE,
  payslipFileHref,
  payslipIdempotencyKey,
  renderPayslipFile,
} from './service';

// The payslip PDF tests (docs/TESTING.md#payroll-review-and-payslip-tests, build step 2.10,
// chunk C3; decisions 363, 364 and 366 in docs/BUILD_PLAN.md), end to end on the database and
// through Core's real approvals engine and file route checks: A1's payslip (rendered on first
// open, and by the job for the rest, then `payslipsPending` cleared), A15 (who opens a payslip
// file, each open a `reveal`; the job run twice leaves one PDF per line), the self-service list
// with no amount, and the PDF rendered with no company settings record and with placeholders.
// Step 2.9's people (P1 net ₱11,595.20); made-up data only (HANDOFF item 318).

const pesos = (amount: number): Centavos => Math.round(amount * 100);
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
let hr: Person; // Ana
let accountant: Person; // Dan
let ben: Person; // Board
let boss: Person; // A's and B's supervisor
let A: Person; // P1
let B: Person; // P2
let runId: string;
let lineA: string;
let lineB: string;

function setNow(iso: string = TODAY) {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(iso));
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

async function approveTimesheet(p: Person): Promise<void> {
  const view = await getOwnTimesheetView(p.actor, { cutOff: '2026-09-26' });
  if (!view?.timesheet.id) throw new Error('No timesheet.');
  const { approvalRequestId } = await submitTimesheet(p.actor, { timesheetId: view.timesheet.id });
  await decide(boss.actor, approvalRequestId, 'approve');
  await decide(hr.actor, approvalRequestId, 'approve');
}

async function lineIdOf(p: Person): Promise<string> {
  const line = await PayrollRunEmployeeModel.findOne({
    runId: new Types.ObjectId(runId),
    employeeId: new Types.ObjectId(p.employeeId),
  }).lean();
  if (!line) throw new Error('No line.');
  return line._id.toHexString();
}

async function fileIdOf(lineId: string): Promise<string | null> {
  const line = await PayrollRunEmployeeModel.findById(lineId).lean();
  return line?.payslip?.fileId?.toHexString() ?? null;
}

async function payslipFiles() {
  return database()
    .collection('storedFiles')
    .find({ ownerType: PAYSLIP_FILE_TYPE, deletedAt: null })
    .toArray();
}

async function netPayReveals() {
  return (await auditEntries('talent.payrollRunEmployee')).filter(
    (entry) => entry.action === 'reveal' && (entry.fields as string[]).includes('netPay'),
  );
}

/** Step 2.9's generic reveal of a line's net pay (the Payslips section's Reveal button). */
const revealNetPay = (who: Person, lineId: string) =>
  revealSensitiveField({
    actor: who.actor,
    ownerType: 'talent.payrollRunEmployee',
    ownerId: lineId,
    field: 'netPay',
  });

async function fileReveals() {
  return (await auditEntries('talent.payrollRunEmployee')).filter(
    (entry) => entry.action === 'reveal' && (entry.fields as string[]).includes('file'),
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
  const HRD = await department('Human Resource', 'HR');
  const ACC = await department('Accounting', 'ACCT');
  const BOD = await department('Board of Directors', 'BOD');
  hr = await person('Ana', 'Reyes', HRD, { talent: 'write' });
  accountant = await person('Dan', 'Cruz', ACC, { talent: 'read' });
  ben = await person('Ben', 'Lim', BOD);
  boss = await person('Bea', 'Tan', NET);
  for (const approver of [hr, boss, ben]) await uploadESignature(approver.actor, pngFile());
  registerTalentApprovalSigner();
  registerTalentApprovalTypes();
  registerTalentFileAccess();
  registerTalentSensitiveReveals();

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
    await setBankAccount(hr.actor, {
      employeeId: who.employeeId,
      version: await recordVersion(who),
      bank,
      accountNumber: number,
      accountName: `${who.firstName} ${who.lastName}`,
    });
  }

  // P1: Overtime timesheet, Sep 26 – Oct 10 (step 2.9's P1, without its reimbursement).
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
  for (const p of [A, B]) await approveTimesheet(p);

  runId = (await createPayrollDraftRun(hr.actor, { periodStart: '2026-09-26' })).id;
  lineA = await lineIdOf(A);
  lineB = await lineIdOf(B);
  vi.useRealTimers();
});

afterAll(async () => {
  await rm(storageDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------------------------

describe('before the run is finalized', () => {
  it('refuses the employee’s own net pay on a draft line through the generic reveal, writing nothing', async () => {
    await expect(revealNetPay(A, lineA)).rejects.toBeInstanceOf(ActionError);
    expect(await netPayReveals()).toHaveLength(0);
  });

  it('has no payslip to list, open or render', async () => {
    expect(await listOwnPayslips(A.actor)).toEqual([]);
    expect(await openPayslipHref(A.actor, lineA)).toBeNull();
    expect(await openPayslipHref(hr.actor, lineA)).toBeNull();
    expect(await renderPayslipFile(lineA)).toBeNull();

    // Submitted and approved by a Board member: the run is finalized with payslips pending.
    const draft = await PayrollRunModel.findById(runId).lean();
    const { approvalRequestId } = await submitPayrollRun(hr.actor, {
      runId,
      version: draft?.version ?? 0,
    });
    expect(await openPayslipHref(A.actor, lineA)).toBeNull();
    await decide(ben.actor, approvalRequestId, 'approve');
    const run = await PayrollRunModel.findById(runId).lean();
    expect(run).toMatchObject({ status: 'finalized', payslipsPending: true });
    expect(await fileIdOf(lineA)).toBeNull();
    expect(await fileIdOf(lineB)).toBeNull();
    expect(await payslipFiles()).toHaveLength(0);
  });
});

describe('payslip PDFs (A1, A15)', () => {
  it('lists the employee’s own payslips with no amount, before any PDF is rendered', async () => {
    const rows = await listOwnPayslips(A.actor);
    const run = await PayrollRunModel.findById(runId).lean();
    expect(rows).toEqual([
      {
        lineId: lineA,
        runId,
        runNumber: run?.number,
        periodStart: '2026-09-26',
        periodEnd: '2026-10-10',
        periodText: 'Sep 26 – Oct 10, 2026',
        payDate: '2026-10-15',
        payDateText: 'Oct 15, 2026',
        netPay: {
          ownerType: 'talent.payrollRunEmployee',
          ownerId: lineA,
          field: 'netPay',
          mask: '••••',
        },
        ready: false,
      },
    ]);
    expect(JSON.stringify(rows)).not.toMatch(/11595|1159520|13637/);
    // Someone with no line in a finalized run has none.
    expect(await listOwnPayslips(ben.actor)).toEqual([]);
    expect(await listOwnPayslips(hr.actor)).toEqual([]);
  });

  it('lets the employee reveal their own net pay on the finalized line, audited; never another’s', async () => {
    // Step 2.9's P1 without its ₱350.00 reimbursement (see the setup).
    expect(await revealNetPay(A, lineA)).toBe(String(pesos(11245.2)));
    const reveals = await netPayReveals();
    expect(reveals).toHaveLength(1);
    const run = await PayrollRunModel.findById(runId).lean();
    expect(reveals[0]).toMatchObject({
      actorId: new Types.ObjectId(A.userId),
      module: 'talent',
      record: {
        type: 'talent.payrollRunEmployee',
        id: new Types.ObjectId(lineA),
        label: `${run?.number} · ${A.employeeNumber}`,
      },
      fields: ['netPay'],
    });
    // Another employee, a Board member as such and a supervisor are refused before any entry.
    for (const who of [B, ben, boss]) {
      await expect(revealNetPay(who, lineA), who.firstName).rejects.toBeInstanceOf(
        AccessDeniedError,
      );
    }
    expect(await netPayReveals()).toHaveLength(1);
  });

  it('renders on first open with no company settings record, once even when two renders race', async () => {
    expect(await loadPayslipCompany()).toBeNull();
    // Refused before anything is rendered: another employee, a Board member, a supervisor.
    for (const who of [B, ben, boss]) expect(await openPayslipHref(who.actor, lineA)).toBeNull();
    expect(await fileIdOf(lineA)).toBeNull();

    const [href, raced] = await Promise.all([
      openPayslipHref(A.actor, lineA),
      renderPayslipFile(lineA),
    ]);
    const fileId = await fileIdOf(lineA);
    expect(fileId).not.toBeNull();
    expect(href).toBe(payslipFileHref(fileId ?? ''));
    expect(raced?.fileId).toBe(fileId);
    const files = await payslipFiles();
    expect(files).toHaveLength(1);
    expect(files[0]).toMatchObject({
      contentType: 'application/pdf',
      source: 'generated',
      ownerId: new Types.ObjectId(lineA),
      idempotencyKey: payslipIdempotencyKey(lineA),
      originalName: `Payslip ${A.employeeNumber} 2026-10-15.pdf`,
    });
    // Opening again returns the same file without rendering.
    expect(await openPayslipHref(A.actor, lineA)).toBe(href);
    expect(await renderPayslipFile(lineA)).toEqual({ lineId: lineA, fileId, rendered: false });
    // The run stays pending until every line has its PDF.
    expect((await PayrollRunModel.findById(runId).lean())?.payslipsPending).toBe(true);
    expect(await getPayrollRunView(hr.actor, runId)).toMatchObject({
      employeeCount: 2,
      payslipsReadyCount: 1,
    });
    expect((await listOwnPayslips(A.actor))[0]?.ready).toBe(true);
  });

  it('A1: the job renders the rest with placeholder company details, clears the flag, and is idempotent', async () => {
    // The seed's placeholder company details print as they are.
    const companyLoader = coreSeedLoaders.find((loader) => loader.name === 'companySettings');
    await companyLoader?.run();
    const company = await loadPayslipCompany();
    expect(company).toMatchObject({ logo: null });
    expect(company?.registeredName).toBeTruthy();

    const first = await runPayslipPdfs();
    expect(first).toMatchObject({ runs: 1, rendered: 1, failed: 0, cleared: 1 });
    expect(await fileIdOf(lineB)).not.toBeNull();
    expect((await PayrollRunModel.findById(runId).lean())?.payslipsPending).toBe(false);
    expect((await getPayrollRunView(hr.actor, runId))?.payslipsReadyCount).toBe(2);

    const second = await runPayslipPdfs();
    expect(second).toMatchObject({ runs: 0, rendered: 0, failed: 0, cleared: 0 });
    // One PDF per line.
    const files = await payslipFiles();
    expect(files.map((file) => String(file.ownerId)).sort()).toEqual([lineA, lineB].sort());
    expect(JSON.stringify(first) + JSON.stringify(second)).not.toMatch(/Payee|11595/);
  });

  it('A15: the file opens for the employee and HR, Accounting, each writing a reveal first; never for others', async () => {
    const fileA = (await fileIdOf(lineA)) ?? '';
    const before = (await fileReveals()).length;
    for (const viewer of [A, accountant, hr]) {
      const opened = await openAccessibleFile(currentUser(viewer), fileA);
      expect(opened, `${viewer.firstName} opens`).not.toBeNull();
      const reader = opened?.stream.getReader();
      const head = await reader?.read();
      expect(
        Buffer.from(head?.value ?? new Uint8Array())
          .subarray(0, 5)
          .toString(),
      ).toBe('%PDF-');
      await reader?.cancel();
    }
    const reveals = await fileReveals();
    expect(reveals).toHaveLength(before + 3);
    const run = await PayrollRunModel.findById(runId).lean();
    expect(reveals.at(-3)).toMatchObject({
      actorId: new Types.ObjectId(A.userId),
      module: 'talent',
      record: {
        type: 'talent.payrollRunEmployee',
        id: new Types.ObjectId(lineA),
        label: `${run?.number} · ${A.employeeNumber}`,
      },
      fields: ['file'],
    });
    expect(reveals.at(-2)?.actorId).toEqual(new Types.ObjectId(accountant.userId));

    // Another employee, a Board member as such and a supervisor get "File not found." (null).
    for (const viewer of [B, ben, boss]) {
      expect(await openAccessibleFile(currentUser(viewer), fileA), viewer.firstName).toBeNull();
    }
    expect(await fileReveals()).toHaveLength(before + 3);
    // Through the service too: HR and Accounting open any employee's, others none.
    expect(await openPayslipHref(accountant.actor, lineA)).toBe(payslipFileHref(fileA));
    expect(await openPayslipHref(B.actor, lineA)).toBeNull();
    expect(await openPayslipHref(ben.actor, lineB)).toBeNull();
  });

  it('writes no amount or account number to the audit log', async () => {
    const text = withoutIdsAndDates(await rawAuditJson());
    for (const secret of ['9876543217', '1234567895', '11595', '1159520', '1124520', '1363750']) {
      expect(text).not.toContain(secret);
    }
  });
});
