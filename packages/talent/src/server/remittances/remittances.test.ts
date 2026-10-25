import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Types } from 'mongoose';
import { connectDb } from '@pulse/db';
import { AccessDeniedError, ActionError, type Centavos } from '@pulse/core';
import { isEncryptedValue, openAccessibleFile, resolveModuleAccess } from '@pulse/core/server';
import { coreSeedLoaders } from '@pulse/core/server/seed';
import type { PayrollLineKind } from '../../payroll-run';
import {
  REMITTANCE_BIR_NO_UPLOAD_TEXT,
  REMITTANCE_FISCAL_PLACEHOLDER_TEXT,
  REMITTANCE_PAID_LOCKED_MESSAGE,
  REMITTANCE_REPORT_CHANGED_MESSAGE,
  type RemittanceAgency,
  sumLinesOfKind,
} from '../../remittance';
import { registerTalentApprovalTypes } from '../change-requests/service';
import { addCompensationEntry } from '../compensation/service';
import { registerTalentApprovalSigner, uploadESignature } from '../e-signatures/service';
import { EmployeeRecordModel } from '../employee-records/model';
import { setBankAccount, setGovernmentIds } from '../employee-records/service';
import { registerTalentFileAccess } from '../files/registrations';
import { PayrollFlagAcknowledgementModel, PayrollManualEntryModel } from '../payroll-review/model';
import { submitPayrollRun } from '../payroll-review/submit';
import { PayrollRunEmployeeModel, PayrollRunModel } from '../payroll-runs/model';
import { createPayrollDraftRun, getPayrollRunLine } from '../payroll-runs/service';
import {
  REMITTANCE_GENERATE_DENIED,
  REMITTANCE_PAYMENT_DENIED,
  REMITTANCES_DENIED,
} from '../policy';
import {
  approvedLeave,
  auditEntries,
  currentUser,
  database,
  decide,
  type Department,
  department,
  notifications,
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
import { exportRemittanceReport, REMITTANCE_FILE_TYPE } from './exports';
import { generateRemittanceReport } from './generate';
import { remittanceReminderDedupeKey, runRemittanceReminders } from './job';
import {
  REMITTANCE_PAYMENT_RECORD_TYPE,
  REMITTANCE_REPORT_RECORD_TYPE,
  RemittancePaymentModel,
  RemittanceReportModel,
} from './model';
import {
  correctRemittancePayment,
  recordRemittancePayment,
  voidRemittancePayment,
} from './payments';
import { getRemittanceReportPage, getRemittanceStatus, listRemittances } from './service';
import { showRemittanceAmounts } from './view';

// The remittance service tests (docs/TESTING.md#remittance-tests, build step 2.11, decisions
// 377–400 in docs/BUILD_PLAN.md), end to end on the database with October 2026's two runs
// finalized through step 2.10's real approval: completeness (R4), the SSS report equal to the
// runs' lines (R1, the Done when), PhilHealth and Pag-IBIG (R3), BIR 1601-C (R12), access, "Show
// amounts" and the exports with their audit (R14), a missing ID and a placeholder employer number
// (R6, R13), the payment with its warning (R7, R2, the Done when), corrections (R8), the lock and
// the void (R9), and that no amount or ID is ever in an audit entry or a notification. Step 2.9's
// people (P1, P2, P6) and figures; made-up data only.

const pesos = (amount: number): Centavos => Math.round(amount * 100);
const OCT_19 = '2026-10-19T10:00:00+08:00';
const OCT_26 = '2026-10-26T10:00:00+08:00';
const NOV_28 = '2026-11-28T10:00:00+08:00';

const IDS_A = {
  tin: '900123456781',
  sss: '0498765432',
  philhealth: '120987654329',
  pagibig: '121234567893',
  rdoCode: '043',
};
const IDS_B = {
  tin: '900000000033',
  sss: '0412345678',
  philhealth: '120000000017',
  pagibig: '121000000025',
  rdoCode: '043',
};

let storageDir: string;
let NET: Department;
let OFF: Department;
let hr: Person; // Ana
let dan: Person; // Accounting, Talent Read
let reader: Person; // Talent Read, not HR or Accounting
let ben: Person; // Board
let boss: Person; // A's and B's supervisor
let A: Person; // P1, then P6
let B: Person; // P2
let run1: string;
let run2: string;

function setNow(iso: string = OCT_19) {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(iso));
}

beforeEach(() => setNow(NOV_28));
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

async function approveTimesheet(p: Person, cutOff: string): Promise<void> {
  const view = await getOwnTimesheetView(p.actor, { cutOff });
  if (!view?.timesheet.id) throw new Error('No timesheet.');
  const { approvalRequestId } = await submitTimesheet(p.actor, { timesheetId: view.timesheet.id });
  await decide(boss.actor, approvalRequestId, 'approve');
  await decide(hr.actor, approvalRequestId, 'approve');
}

/** Submits a run and has the Board member approve it: step 2.10's real approval. */
async function finalize(runId: string): Promise<void> {
  const draft = await PayrollRunModel.findById(runId).lean();
  const { approvalRequestId } = await submitPayrollRun(hr.actor, {
    runId,
    version: draft?.version ?? 0,
  });
  await decide(ben.actor, approvalRequestId, 'approve');
  const run = await PayrollRunModel.findById(runId).lean();
  if (run?.status !== 'finalized') throw new Error('The run wasn’t finalized.');
}

/** The sum of `kind` over both runs' lines, read from the runs (never the report). */
async function linesSum(kind: PayrollLineKind, who: Person[] = [A, B]): Promise<Centavos> {
  let total = 0;
  for (const runId of [run1, run2]) {
    for (const p of who) {
      const line = await getPayrollRunLine(runId, p.employeeId);
      if (!line) throw new Error('No line.');
      total += sumLinesOfKind(line.breakdown, kind);
    }
  }
  return total;
}

const generate = (who: Person, agency: string, version?: number) =>
  generateRemittanceReport(who.actor, { agency, month: '2026-10', version });

async function reportOf(agency: string) {
  const report = await RemittanceReportModel.findOne({
    agency: agency as RemittanceAgency,
    month: '2026-10',
  }).lean();
  if (!report) throw new Error('No report.');
  return report;
}

const exportAs = async (who: Person, agency: string, format: string) =>
  exportRemittanceReport(who.actor, {
    agency,
    month: '2026-10',
    format,
    version: (await reportOf(agency)).version,
  });

async function fileText(fileId: string): Promise<string> {
  const opened = await openAccessibleFile(currentUser(hr), fileId);
  if (!opened) throw new Error('The file didn’t open.');
  return new Response(opened.stream).text();
}

async function reportAudit(action?: string) {
  return (await auditEntries(REMITTANCE_REPORT_RECORD_TYPE)).filter(
    (entry) => !action || entry.action === action,
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
    RemittanceReportModel.init(),
    RemittancePaymentModel.init(),
  ]);
  await seedPayrollSettings();
  // The company settings record with its placeholders, as `pnpm seed:admin` adds it.
  await coreSeedLoaders.find((loader) => loader.name === 'companySettings')?.run();
  NET = await department('Network', 'NET');
  OFF = await department('Office', 'OFF');
  await setPositionType(OFF, 'standard');
  const HRD = await department('Human Resource', 'HR');
  const ACC = await department('Accounting', 'ACCT');
  const BOD = await department('Board of Directors', 'BOD');
  hr = await person('Ana', 'Reyes', HRD, { talent: 'write' });
  dan = await person('Dan', 'Cruz', ACC, { talent: 'read' });
  reader = await person('Rita', 'Lopez', NET, { talent: 'read' });
  ben = await person('Ben', 'Lim', BOD);
  boss = await person('Bea', 'Tan', NET);
  for (const approver of [hr, boss, ben]) await uploadESignature(approver.actor, pngFile());
  registerTalentApprovalSigner();
  registerTalentApprovalTypes();
  registerTalentFileAccess();

  setNow(OCT_19);
  await setLeaveSettings({ goLiveDate: '2026-09-26' });
  A = await employee(NET, 21750);
  B = await employee(OFF, 26100);
  for (const [who, ids, bank, number] of [
    [A, IDS_A, 'unionbank', '0009876543217'],
    [B, IDS_B, 'rcbc', '0001234567895'],
  ] as const) {
    await setGovernmentIds(hr.actor, {
      employeeId: who.employeeId,
      version: await recordVersion(who),
      ...ids,
    });
    await setBankAccount(hr.actor, {
      employeeId: who.employeeId,
      version: await recordVersion(who),
      bank,
      accountNumber: number,
      accountName: `${who.firstName} ${who.lastName}`,
    });
  }

  // PAY-2026-0001, Sep 26 – Oct 10: step 2.9's P1 (without its reimbursement) and P2.
  await entryOf(A, '2026-09-28', '08:00', '19:00', true);
  for (const day of ['2026-09-29', '2026-09-30']) await entryOf(A, day, '08:00', '17:00');
  await entryOf(A, '2026-10-01', '08:30', '17:00');
  await entryOf(A, '2026-10-03', '08:00', '12:00', true);
  await entryOf(A, '2026-10-05', '08:00', '17:00');
  await entryOf(A, '2026-10-06', '08:00', '23:00', true);
  for (const day of ['2026-10-07', '2026-10-08', '2026-10-09']) {
    await entryOf(A, day, '08:00', '17:00');
  }
  await entryOf(B, '2026-09-28', '08:00', '17:00');
  await entryOf(B, '2026-09-29', '08:00', '19:00', true);
  await entryOf(B, '2026-09-30', '08:00', '16:00');
  for (const day of ['2026-10-01', '2026-10-02', '2026-10-05', '2026-10-06', '2026-10-07']) {
    await entryOf(B, day, '08:00', '17:00');
  }
  await entryOf(B, '2026-10-03', '08:00', '12:00', true);
  await approvedLeave(B, 'vacation', '2026-10-08', '2026-10-09', 2);
  for (const p of [A, B]) await approveTimesheet(p, '2026-09-26');
  run1 = (await createPayrollDraftRun(hr.actor, { periodStart: '2026-09-26' })).id;
  await finalize(run1);
  vi.useRealTimers();
});

afterAll(async () => {
  await rm(storageDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------------------------

describe('R4: October 2026 before PAY-2026-0002 is finalized', () => {
  it('is "Not ready", and generating names the cut-off still to compute', async () => {
    setNow(OCT_26);
    const list = await listRemittances(hr.actor);
    const october = list.months.find((group) => group.month === '2026-10');
    expect(october?.label).toBe('October 2026');
    expect(october?.agencies.map((row) => [row.agency, row.status, row.statusLabel])).toEqual([
      ['sss', 'notReady', 'Not ready'],
      ['philhealth', 'notReady', 'Not ready'],
      ['pagibig', 'notReady', 'Not ready'],
      ['bir1601c', 'notReady', 'Not ready'],
    ]);
    await expect(generate(hr, 'sss')).rejects.toThrow(
      'Compute and finalize the run for Oct 11 – 25, 2026 first.',
    );
  });

  it('refuses while PAY-2026-0002 is a draft, then is ready once it is finalized', async () => {
    setNow(OCT_26);
    // PAY-2026-0002, Oct 11 – 25: both present every day, nothing else (step 2.9's P6 for A).
    for (const day of [
      '2026-10-12',
      '2026-10-13',
      '2026-10-14',
      '2026-10-15',
      '2026-10-16',
      '2026-10-19',
      '2026-10-20',
      '2026-10-21',
      '2026-10-22',
      '2026-10-23',
    ]) {
      await entryOf(A, day, '08:00', '17:00');
      await entryOf(B, day, '08:00', '17:00');
    }
    for (const p of [A, B]) await approveTimesheet(p, '2026-10-11');
    run2 = (await createPayrollDraftRun(hr.actor, { periodStart: '2026-10-11' })).id;
    await expect(generate(hr, 'sss')).rejects.toThrow(
      'Finalize Oct 11 – 25, 2026 first: its pay date is in October 2026.',
    );
    expect((await getRemittanceStatus('sss', '2026-10'))?.status).toBe('notReady');
    expect(await RemittanceReportModel.countDocuments({})).toBe(0);
    await finalize(run2);
    const status = await getRemittanceStatus('sss', '2026-10', { today: '2026-10-26' });
    expect(status).toMatchObject({ status: 'ready', dueDate: '2026-11-30', overdue: false });
  });
});

describe('R1: the SSS report equals its finalized runs (the Done when)', () => {
  it('needs Talent Write and HR or the System Administrator to generate', async () => {
    for (const who of [dan, reader, ben]) {
      await expect(generate(who, 'sss')).rejects.toThrow(AccessDeniedError);
    }
    await expect(generate(dan, 'sss')).rejects.toThrow(REMITTANCE_GENERATE_DENIED);
    expect(await RemittanceReportModel.countDocuments({})).toBe(0);
  });

  it('holds employee ₱2,375.00, employer ₱4,750.00 and EC ₱60.00: ₱7,185.00 due', async () => {
    const generated = await generate(hr, 'sss');
    expect(generated).toMatchObject({ version: 1, regenerated: false });
    // A second "Generate report" from a page loaded before the first is refused, not regenerated.
    await expect(generate(hr, 'sss')).rejects.toThrow(REMITTANCE_REPORT_CHANGED_MESSAGE);
    const amounts = await showRemittanceAmounts(hr.actor, { agency: 'sss', month: '2026-10' });
    if (!amounts) throw new Error('No amounts.');
    const [a, b] = amounts.rows;
    expect(a).toMatchObject({
      employeeId: A.employeeId,
      maskedId: '••••5432',
      basisCentavos: pesos(22500),
      employee: {
        totalCentavos: pesos(1125),
        regularCentavos: pesos(1000),
        mpfCentavos: pesos(125),
      },
      employer: {
        totalCentavos: pesos(2250),
        regularCentavos: pesos(2000),
        mpfCentavos: pesos(250),
      },
      ecCentavos: pesos(30),
      totalCentavos: pesos(3405),
      flags: { differsFromSchedule: false, missingId: false, unverifiedId: false },
    });
    expect(b).toMatchObject({
      employeeId: B.employeeId,
      maskedId: '••••5678',
      basisCentavos: pesos(25000),
      employee: {
        totalCentavos: pesos(1250),
        regularCentavos: pesos(1000),
        mpfCentavos: pesos(250),
      },
      employer: {
        totalCentavos: pesos(2500),
        regularCentavos: pesos(2000),
        mpfCentavos: pesos(500),
      },
      ecCentavos: pesos(30),
      totalCentavos: pesos(3780),
    });
    expect(amounts.totals).toMatchObject({
      employeeCount: 2,
      employee: { totalCentavos: pesos(2375) },
      employer: { totalCentavos: pesos(4750) },
      ecCentavos: pesos(60),
      amountDueCentavos: pesos(7185),
    });
    // Each equal to the sum of the two runs' lines.
    expect(amounts.totals.employee.totalCentavos).toBe(await linesSum('sssEmployee'));
    expect(amounts.totals.employer.totalCentavos).toBe(await linesSum('sssEmployer'));
    expect(amounts.totals.ecCentavos).toBe(await linesSum('sssEc'));
    // The rows hold no full ID or date of birth on the page.
    expect(JSON.stringify(amounts)).not.toContain(IDS_A.sss);
    expect(amounts.rows[0]).not.toHaveProperty('idNumber');
    expect(amounts.rows[0]).not.toHaveProperty('dateOfBirth');

    const page = await getRemittanceReportPage(hr.actor, '2026-10', 'sss');
    expect(page).toMatchObject({
      title: 'SSS · October 2026',
      status: 'generated',
      dueDate: '2026-11-30',
      dueText: 'Due Nov 30, 2026',
      incompleteMessage: null,
      goLiveNote: null,
      report: {
        version: 1,
        employeeCount: 2,
        flagCounts: { differsFromSchedule: 0, missingId: 0, unverifiedId: 0 },
        generatedByName: 'Ana Reyes',
      },
    });
    expect(page?.sourceRuns.map((run) => [run.number, run.periodText])).toEqual([
      ['PAY-2026-0001', 'Sep 26 – Oct 10, 2026'],
      ['PAY-2026-0002', 'Oct 11 – 25, 2026'],
    ]);
    // The page sends no amount or ID.
    expect(JSON.stringify(page)).not.toContain('718500');
    expect(JSON.stringify(page)).not.toContain(IDS_A.sss);

    const created = await reportAudit('create');
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({ record: { label: 'SSS · 2026-10' } });
  });
});

describe('R3: PhilHealth and Pag-IBIG for October 2026', () => {
  it('PhilHealth: PS ₱543.75 and ₱652.50, ES the same, ₱2,392.50 due', async () => {
    await generate(hr, 'philhealth');
    const amounts = await showRemittanceAmounts(dan.actor, {
      agency: 'philhealth',
      month: '2026-10',
    });
    expect(amounts?.rows.map((row) => [row.basisCentavos, row.employee.totalCentavos])).toEqual([
      [pesos(21750), pesos(543.75)],
      [pesos(26100), pesos(652.5)],
    ]);
    expect(amounts?.totals.employer.totalCentavos).toBe(pesos(543.75 + 652.5));
    expect(amounts?.totals.amountDueCentavos).toBe(pesos(2392.5));
    expect(amounts?.totals.employee.totalCentavos).toBe(await linesSum('philhealthEmployee'));
  });

  it('Pag-IBIG: ₱200.00 and ₱200.00 each on ₱10,000.00, ₱800.00 due', async () => {
    await generate(hr, 'pagibig');
    const amounts = await showRemittanceAmounts(hr.actor, { agency: 'pagibig', month: '2026-10' });
    for (const row of amounts?.rows ?? []) {
      expect(row).toMatchObject({
        basisCentavos: pesos(10000),
        employee: { totalCentavos: pesos(200) },
        employer: { totalCentavos: pesos(200) },
      });
    }
    expect(amounts?.totals.amountDueCentavos).toBe(pesos(800));
  });
});

describe('R12: BIR 1601-C for October 2026', () => {
  it('item 25 is the runs’ withholding, item 19 the employee shares, and there is no upload file', async () => {
    await generate(hr, 'bir1601c');
    const amounts = await showRemittanceAmounts(hr.actor, {
      agency: 'bir1601c',
      month: '2026-10',
    });
    const items = Object.fromEntries(
      (amounts?.birItems ?? []).map((entry) => [entry.item, entry.amountCentavos]),
    );
    expect(items['25']).toBe(await linesSum('withholdingTax'));
    expect(amounts?.rows[0]?.bir?.taxWithheldCentavos).toBe(pesos(57.92));
    expect(await linesSum('withholdingTax', [A])).toBe(pesos(57.92));
    expect(items['19']).toBe(
      (await linesSum('sssEmployee')) +
        (await linesSum('philhealthEmployee')) +
        (await linesSum('pagibigEmployee')),
    );
    expect(items['21']).toBe(
      (items['15'] ?? 0) +
        (items['16'] ?? 0) +
        (items['17'] ?? 0) +
        (items['18'] ?? 0) +
        (items['19'] ?? 0) +
        (items['20'] ?? 0),
    );
    expect(items['22']).toBe((items['14'] ?? 0) - (items['21'] ?? 0));
    expect(amounts?.item22Difference).toBeNull();
    const page = await getRemittanceReportPage(hr.actor, '2026-10', 'bir1601c');
    expect(page?.report).toMatchObject({
      upload: null,
      noUploadText: REMITTANCE_BIR_NO_UPLOAD_TEXT,
    });
    await expect(exportAs(hr, 'bir1601c', 'upload')).rejects.toThrow(REMITTANCE_BIR_NO_UPLOAD_TEXT);
  });
});

describe('R14: access, "Show amounts" and the exports', () => {
  it('gives a Talent reader who isn’t HR or Accounting, a Board member and an employee nothing', async () => {
    const exportsBefore = (await reportAudit('export')).length;
    const revealsBefore = (await reportAudit('reveal')).length;
    for (const who of [reader, ben, A]) {
      await expect(listRemittances(who.actor)).rejects.toThrow(REMITTANCES_DENIED);
      await expect(getRemittanceReportPage(who.actor, '2026-10', 'sss')).rejects.toThrow(
        AccessDeniedError,
      );
      await expect(
        showRemittanceAmounts(who.actor, { agency: 'sss', month: '2026-10' }),
      ).rejects.toThrow(AccessDeniedError);
      await expect(exportAs(who, 'sss', 'pdf')).rejects.toThrow(AccessDeniedError);
    }
    expect(await reportAudit('export')).toHaveLength(exportsBefore);
    expect(await reportAudit('reveal')).toHaveLength(revealsBefore);
  });

  it('"Show amounts" writes its reveal on every press', async () => {
    const before = (await reportAudit('reveal')).length;
    await showRemittanceAmounts(dan.actor, { agency: 'sss', month: '2026-10' });
    await showRemittanceAmounts(dan.actor, { agency: 'sss', month: '2026-10' });
    const reveals = await reportAudit('reveal');
    expect(reveals).toHaveLength(before + 2);
    expect(reveals.at(-1)).toMatchObject({
      fields: ['amounts'],
      record: { label: 'SSS · 2026-10' },
      actorId: new Types.ObjectId(dan.userId),
    });
  });

  it('exports the PDF and Excel file once per version, each press audited, each open revealed', async () => {
    const pdf = await exportAs(dan, 'sss', 'pdf');
    expect(pdf.fileName).toBe('SSS October 2026.pdf');
    const again = await exportAs(dan, 'sss', 'pdf');
    expect(again.fileId).toBe(pdf.fileId);
    const exports = (await reportAudit('export')).filter((entry) =>
      (entry.fields as string[]).includes('pdf'),
    );
    expect(exports).toHaveLength(2);
    const pdfText = await fileText(pdf.fileId);
    expect(pdfText.startsWith('%PDF-')).toBe(true);
    const xlsx = await exportAs(hr, 'sss', 'xlsx');
    expect(xlsx.fileName).toBe('SSS October 2026.xlsx');
    expect((await fileText(xlsx.fileId)).startsWith('PK')).toBe(true);
    const fileReveals = (await reportAudit('reveal')).filter((entry) =>
      (entry.fields as string[]).includes('file'),
    );
    expect(fileReveals).toHaveLength(2);
    // Someone who may not see remittances doesn't open the file.
    expect(await openAccessibleFile(currentUser(reader), pdf.fileId)).toBeNull();
    const stored = await database()
      .collection('storedFiles')
      .find({ ownerType: REMITTANCE_FILE_TYPE })
      .toArray();
    expect(stored).toHaveLength(2);
  });
});

describe('R6 and R13: a missing SS number and a placeholder employer number', () => {
  it('refuses the upload file while the SSS employer number is a placeholder', async () => {
    const page = await getRemittanceReportPage(hr.actor, '2026-10', 'sss');
    expect(page?.report?.placeholderWarning).toBe(
      'The SSS employer number is still a placeholder. Fill it in in Company settings, then regenerate.',
    );
    expect(page?.report?.upload).toMatchObject({
      verified: false,
      buttonLabel: 'Upload file (layout not verified)',
      warning:
        'This layout hasn’t been checked against SSS’s official file specification. Check it with the portal’s validation before relying on it.',
    });
    await expect(exportAs(hr, 'sss', 'upload')).rejects.toThrow(
      'Fill in the SSS employer number in Company settings, then regenerate the report.',
    );
  });

  it('lists a row with no SS number in the PDF and Excel file, and refuses the upload file', async () => {
    await database()
      .collection('employeeRecords')
      .updateOne(
        { employeeId: new Types.ObjectId(B.employeeId) },
        { $unset: { 'governmentIds.sss': '' } },
      );
    const regenerated = await generate(hr, 'sss', 1);
    expect(regenerated).toMatchObject({ version: 2, regenerated: true });
    expect((await reportAudit('update')).at(-1)).toMatchObject({ reason: 'Regenerated' });
    const report = await reportOf('sss');
    expect(report.files).toEqual({ pdf: null, xlsx: null, upload: null });
    expect(report.flagCounts).toEqual({ differsFromSchedule: 0, missingId: 1, unverifiedId: 0 });
    const amounts = await showRemittanceAmounts(hr.actor, { agency: 'sss', month: '2026-10' });
    expect(amounts?.rows[1]?.notes).toContain('No SS number on file');
    expect(amounts?.rows[1]?.maskedId).toBeNull();
    await expect(exportAs(hr, 'sss', 'pdf')).resolves.toMatchObject({
      fileName: 'SSS October 2026.pdf',
    });
    await expect(exportAs(hr, 'sss', 'xlsx')).resolves.toBeTruthy();
    await expect(exportAs(hr, 'sss', 'upload')).rejects.toThrow(
      'Enter the SS numbers of 1 employee first.',
    );
    // A stale page's version is refused.
    await expect(generate(hr, 'sss', 1)).rejects.toThrow(REMITTANCE_REPORT_CHANGED_MESSAGE);
  });

  it('builds the upload file once both are fixed and the report regenerated (R13)', async () => {
    setNow(OCT_26);
    await setGovernmentIds(hr.actor, {
      employeeId: B.employeeId,
      version: await recordVersion(B),
      ...IDS_B,
    });
    vi.useRealTimers();
    await database()
      .collection('companySettings')
      .updateOne({}, { $set: { sssEmployerNumber: '03-9999999-1' } });
    await generate(hr, 'sss', 2);
    const upload = await exportAs(hr, 'sss', 'upload');
    expect(upload.fileName).toBe('SSS October 2026.txt');
    const text = await fileText(upload.fileId);
    const lines = text.split('\r\n');
    expect(lines).toHaveLength(5);
    expect(lines[0]?.startsWith('000399999991')).toBe(true);
    expect(lines[1]?.slice(0, 12)).toBe(`20${IDS_A.sss}`);
    // P2's detail: regular SS ₱3,000.00, EC ₱30.00 and MPF ₱750.00.
    expect(lines[2]?.slice(0, 12)).toBe(`20${IDS_B.sss}`);
    expect(lines[2]?.slice(53, 63)).toBe('3000.00'.padStart(10));
    expect(lines[2]?.slice(63, 71)).toBe('30.00'.padStart(8));
    expect(lines[2]?.slice(71, 81)).toBe('750.00'.padStart(10));
    // The trailer's totals: ₱6,000.00, ₱60.00 and ₱1,125.00.
    expect(lines[3]).toBe(
      `99000002${'6000.00'.padStart(12)}${'60.00'.padStart(12)}${'1125.00'.padStart(12)}`,
    );
    const stored = await database()
      .collection('storedFiles')
      .findOne({ _id: new Types.ObjectId(upload.fileId) });
    expect(stored).toMatchObject({ contentType: 'text/plain', ownerType: REMITTANCE_FILE_TYPE });
  });
});

describe('R7 and R2: recording the SSS payment (the Done when)', () => {
  const pay = (who: Person, amount: number, extra: Record<string, unknown> = {}) =>
    reportOf('sss').then((report) =>
      recordRemittancePayment(who.actor, {
        agency: 'sss',
        month: '2026-10',
        version: report.version,
        paidOn: '2026-11-27',
        referenceNumber: 'PRN 1234567890123',
        amountCentavos: pesos(amount),
        note: null,
        ...extra,
      }),
    );

  it('R7: warns about ₱7,200.00 instead of saving it', async () => {
    const result = await pay(hr, 7200);
    expect(result).toEqual({
      status: 'amountDiffers',
      message:
        '₱7,200.00 isn’t the report’s amount due of ₱7,185.00. Save anyway if penalties or another month are included.',
    });
    expect(await RemittancePaymentModel.countDocuments({})).toBe(0);
    expect((await reportAudit('reveal')).at(-1)).toMatchObject({ fields: ['amountDue'] });
  });

  it('refuses a future date, a date before the month, a blank reference and a stale page', async () => {
    await expect(pay(hr, 7185, { paidOn: '2026-11-29' })).rejects.toMatchObject({
      field: 'paidOn',
    });
    await expect(pay(hr, 7185, { paidOn: '2026-09-30' })).rejects.toMatchObject({
      field: 'paidOn',
    });
    await expect(pay(hr, 7185, { referenceNumber: ' ' })).rejects.toBeInstanceOf(ActionError);
    await expect(pay(hr, 7185, { version: 1 })).rejects.toThrow(REMITTANCE_REPORT_CHANGED_MESSAGE);
    await expect(pay(dan, 7185)).rejects.toThrow(REMITTANCE_PAYMENT_DENIED);
    expect(await RemittancePaymentModel.countDocuments({})).toBe(0);
  });

  it('R2: ₱7,185.00 on Nov 27 marks SSS October 2026 paid', async () => {
    const result = await pay(hr, 7185);
    expect(result).toMatchObject({ status: 'saved' });
    const report = await reportOf('sss');
    expect(report.status).toBe('paid');
    const payment = await RemittancePaymentModel.findById(report.paymentId).lean();
    expect(payment).toMatchObject({
      referenceNumber: 'PRN 1234567890123',
      reportVersion: report.version,
      fiscalDisbursement: { status: 'notRecorded' },
      supersedesId: null,
    });
    const list = await listRemittances(hr.actor);
    const sss = list.months
      .find((group) => group.month === '2026-10')
      ?.agencies.find((row) => row.agency === 'sss');
    expect(sss).toMatchObject({
      status: 'paid',
      statusLabel: 'Paid',
      paidText: 'Paid Nov 27, 2026 · PRN 1234567890123',
    });
    const page = await getRemittanceReportPage(dan.actor, '2026-10', 'sss');
    expect(page?.livePayment).toMatchObject({
      kind: 'payment',
      paidOn: '2026-11-27',
      referenceNumber: 'PRN 1234567890123',
      recordedByName: 'Ana Reyes',
    });
    expect(page?.fiscalPlaceholderText).toBe(REMITTANCE_FISCAL_PLACEHOLDER_TEXT);
    const entries = await auditEntries(REMITTANCE_PAYMENT_RECORD_TYPE);
    expect(entries.at(-1)).toMatchObject({ action: 'create', record: { label: 'SSS · 2026-10' } });
    expect(JSON.stringify(entries.at(-1))).not.toContain('718500');
    const amounts = await showRemittanceAmounts(hr.actor, { agency: 'sss', month: '2026-10' });
    expect(amounts?.payments).toEqual([
      { id: report.paymentId?.toHexString(), amountCentavos: pesos(7185) },
    ]);
  });

  it('sends no SSS reminder for October after the payment', async () => {
    const at = (day: string) => new Date(`${day}T08:00:00+08:00`);
    await runRemittanceReminders(at('2026-11-30'));
    await runRemittanceReminders(at('2026-12-01'));
    const keys = (await notifications()).map((note) => note.dedupeKey);
    for (const kind of ['soon', 'today', 'overdue'] as const) {
      expect(keys).not.toContain(remittanceReminderDedupeKey('sss', '2026-10', kind));
    }
    // Unpaid agencies are still reminded.
    expect(keys).toContain(remittanceReminderDedupeKey('philhealth', '2026-10', 'overdue'));
  });
});

describe('R8: corrections need Talent Write and HR, Accounting or the System Administrator', () => {
  it('refuses Dan with Talent Read, and saves his correction with Talent Write', async () => {
    const report = await reportOf('sss');
    const correction = {
      agency: 'sss',
      month: '2026-10',
      version: report.version,
      paymentId: report.paymentId?.toHexString(),
      paidOn: '2026-11-27',
      referenceNumber: 'PRN 1234567890999',
      amountCentavos: pesos(7185),
      note: 'Bank slip reference',
      reason: 'The PRN was mistyped',
    };
    await expect(correctRemittancePayment(dan.actor, correction)).rejects.toThrow(
      REMITTANCE_PAYMENT_DENIED,
    );
    await expect(voidRemittancePayment(dan.actor, { ...correction, reason: 'No' })).rejects.toThrow(
      AccessDeniedError,
    );
    await database()
      .collection('users')
      .updateOne(
        { _id: new Types.ObjectId(dan.userId) },
        { $set: { 'moduleAccess.talent': 'write' } },
      );
    const writer = {
      ...dan.actor,
      moduleAccess: resolveModuleAccess({
        isSystemAdministrator: false,
        moduleAccess: { talent: 'write' },
      }),
    };
    const result = await correctRemittancePayment(writer, correction);
    expect(result).toMatchObject({ status: 'saved' });
    const after = await reportOf('sss');
    expect(after.status).toBe('paid');
    expect(after.paymentId?.toHexString()).toBe(
      result.status === 'saved' ? result.paymentId : null,
    );
    const entry = await RemittancePaymentModel.findById(after.paymentId).lean();
    expect(entry).toMatchObject({
      referenceNumber: 'PRN 1234567890999',
      supersedesId: report.paymentId,
      reason: 'The PRN was mistyped',
    });
    expect((await auditEntries(REMITTANCE_PAYMENT_RECORD_TYPE)).at(-1)).toMatchObject({
      action: 'update',
      reason: 'The PRN was mistyped',
      actorId: new Types.ObjectId(dan.userId),
    });
    // A correction of a payment that is no longer the live one is refused.
    await expect(correctRemittancePayment(writer, correction)).rejects.toThrow(ActionError);
  });
});

describe('R9: a paid report is locked until its payment is voided', () => {
  it('refuses to regenerate, voids with a reason, then regenerates and is paid again', async () => {
    const report = await reportOf('sss');
    await expect(generate(hr, 'sss', report.version)).rejects.toThrow(
      REMITTANCE_PAID_LOCKED_MESSAGE,
    );
    await voidRemittancePayment(hr.actor, {
      agency: 'sss',
      month: '2026-10',
      paymentId: report.paymentId?.toHexString(),
      reason: 'Recorded against the wrong month',
    });
    const voided = await reportOf('sss');
    expect(voided).toMatchObject({ status: 'generated', paymentId: null });
    expect((await auditEntries(REMITTANCE_PAYMENT_RECORD_TYPE)).at(-1)).toMatchObject({
      action: 'delete',
      reason: 'Recorded against the wrong month',
    });
    expect((await getRemittanceStatus('sss', '2026-10'))?.status).toBe('generated');
    const regenerated = await generate(hr, 'sss', voided.version);
    expect(regenerated.version).toBe(voided.version + 1);
    // Recorded again: it supersedes the void, so the report keeps one chain.
    const again = await recordRemittancePayment(hr.actor, {
      agency: 'sss',
      month: '2026-10',
      version: regenerated.version,
      paidOn: '2026-11-27',
      referenceNumber: 'PRN 1234567890123',
      amountCentavos: pesos(7185),
    });
    expect(again).toMatchObject({ status: 'saved' });
    const page = await getRemittanceReportPage(hr.actor, '2026-10', 'sss');
    expect(page?.paymentHistory.map((entry) => entry.kind)).toEqual([
      'payment',
      'void',
      'correction',
      'payment',
    ]);
    expect(page?.livePayment?.referenceNumber).toBe('PRN 1234567890123');
  });

  it('saves an amount other than the amount due on "Save anyway"', async () => {
    const report = await reportOf('pagibig');
    const result = await recordRemittancePayment(hr.actor, {
      agency: 'pagibig',
      month: '2026-10',
      version: report.version,
      paidOn: '2026-11-14',
      referenceNumber: 'ESRS 0001',
      amountCentavos: pesos(900),
      note: 'Includes a late payment penalty',
      confirmAmount: true,
    });
    expect(result).toMatchObject({ status: 'saved' });
    expect((await reportOf('pagibig')).status).toBe('paid');
  });
});

describe('nothing sensitive is stored in the clear, logged or sent', () => {
  it('keeps the rows, totals and amounts encrypted, and no amount or ID in audit or notifications', async () => {
    const reports = await database().collection('remittanceReports').find({}).toArray();
    for (const report of reports) {
      expect(isEncryptedValue(report.rows)).toBe(true);
      expect(isEncryptedValue(report.totals)).toBe(true);
    }
    const payments = await database().collection('remittancePayments').find({}).toArray();
    for (const payment of payments) {
      if (!payment.voided) expect(isEncryptedValue(payment.amountCentavos)).toBe(true);
    }
    const stored = withoutIdsAndDates(
      `${JSON.stringify(reports)}${JSON.stringify(payments)}${await rawAuditJson()}${JSON.stringify(await notifications())}`,
    );
    for (const secret of [IDS_A.sss, IDS_B.sss, IDS_A.tin, IDS_A.philhealth, IDS_A.pagibig]) {
      expect(stored).not.toContain(secret);
    }
    for (const amount of ['718500', '7,185.00', '237500', '2,375.00']) {
      expect(stored).not.toContain(amount);
    }
  });
});
