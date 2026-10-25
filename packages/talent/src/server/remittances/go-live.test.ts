import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { Types } from 'mongoose';
import { connectDb } from '@pulse/db';
import type { Centavos } from '@pulse/core';
import { registerTalentApprovalTypes } from '../change-requests/service';
import { addCompensationEntry } from '../compensation/service';
import { registerTalentApprovalSigner, uploadESignature } from '../e-signatures/service';
import { EmployeeRecordModel } from '../employee-records/model';
import { setBankAccount, setGovernmentIds } from '../employee-records/service';
import { PayrollFlagAcknowledgementModel, PayrollManualEntryModel } from '../payroll-review/model';
import { addPayrollManualEntry } from '../payroll-review/manual';
import { submitPayrollRun } from '../payroll-review/submit';
import { PayrollRunEmployeeModel, PayrollRunModel } from '../payroll-runs/model';
import { createPayrollDraftRun, getPayrollRunLine } from '../payroll-runs/service';
import { sumLinesOfKind } from '../../remittance';
import {
  decide,
  department,
  type Person,
  person,
  pngFile,
  seedPayrollSettings,
  setLeaveSettings,
  setReportingTo,
} from '../testing/fixtures';
import { TimeEntryModel, TimesheetModel } from '../timesheets/model';
import { createTimeEntry, getOwnTimesheetView } from '../timesheets/service';
import { submitTimesheet } from '../timesheets/submission';
import { generateRemittanceReport } from './generate';
import { RemittancePaymentModel, RemittanceReportModel } from './model';
import { getRemittanceReportPage, listRemittances } from './service';
import { showRemittanceAmounts } from './view';

// The go-live month (docs/TESTING.md#remittance-tests, build step 2.11, decision 378 in
// docs/BUILD_PLAN.md): case R15 — with go-live on 2026-10-11 the first payroll cut-off is
// Oct 11 – 25, so October 2026 is complete with PAY-2026-0001 (Oct 11 – 25) alone, finalized
// through step 2.10's real approval, and its reports carry the note naming Sep 26 – Oct 10.
// Made-up people and figures only.

const pesos = (amount: number): Centavos => Math.round(amount * 100);

let storageDir: string;
let hr: Person;
let ben: Person;
let boss: Person;
let A: Person;
let runId: string;

afterEach(() => {
  vi.useRealTimers();
});

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
  const NET = await department('Network', 'NET');
  const HRD = await department('Human Resource', 'HR');
  const BOD = await department('Board of Directors', 'BOD');
  hr = await person('Ana', 'Reyes', HRD, { talent: 'write' });
  ben = await person('Ben', 'Lim', BOD);
  boss = await person('Bea', 'Tan', NET);
  for (const approver of [hr, boss, ben]) await uploadESignature(approver.actor, pngFile());
  registerTalentApprovalSigner();
  registerTalentApprovalTypes();

  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-26T10:00:00+08:00'));
  await setLeaveSettings({ goLiveDate: '2026-10-11' });
  A = await person('Test', 'Payee1', NET, { dateHired: '2025-01-01' });
  await setReportingTo(A, [boss]);
  await addCompensationEntry(hr.actor, {
    employeeId: A.employeeId,
    effectiveDate: '2025-01-01',
    basicSalaryCentavos: pesos(21750),
    rateType: 'monthly',
    minimumWageEarner: false,
    reason: 'Made-up test salary',
  });
  const version = async () =>
    (await EmployeeRecordModel.findOne({ employeeId: new Types.ObjectId(A.employeeId) }).lean())
      ?.version ?? 0;
  await setGovernmentIds(hr.actor, {
    employeeId: A.employeeId,
    version: await version(),
    tin: '900123456781',
    sss: '0498765432',
    philhealth: '120987654329',
    pagibig: '121234567893',
    rdoCode: '043',
  });
  await setBankAccount(hr.actor, {
    employeeId: A.employeeId,
    version: await version(),
    bank: 'unionbank',
    accountNumber: '0009876543217',
    accountName: 'Test Payee1',
  });
  for (const day of ['12', '13', '14', '15', '16', '19', '20', '21', '22', '23']) {
    await createTimeEntry(A.actor, {
      date: `2026-10-${day}`,
      timeIn: '08:00',
      timeOut: '17:00',
      activity: 'Made-up work',
      clientId: null,
      extraHoursReason: null,
    });
  }
  const view = await getOwnTimesheetView(A.actor, { cutOff: '2026-10-11' });
  if (!view?.timesheet.id) throw new Error('No timesheet.');
  const { approvalRequestId } = await submitTimesheet(A.actor, { timesheetId: view.timesheet.id });
  await decide(boss.actor, approvalRequestId, 'approve');
  await decide(hr.actor, approvalRequestId, 'approve');
  const run = await createPayrollDraftRun(hr.actor, { periodStart: '2026-10-11' });
  runId = run.id;
  // R5: HR overrides the SSS employee share to ₱0.00 (step 2.10).
  await addPayrollManualEntry(hr.actor, {
    runId: run.id,
    employeeId: A.employeeId,
    kind: 'override',
    targetLineKey: 'sssEmployee',
    amountCentavos: 0,
    reason: 'Made-up correction: deducted by the old system',
  });
  const draft = await PayrollRunModel.findById(run.id).lean();
  const submitted = await submitPayrollRun(hr.actor, {
    runId: run.id,
    version: draft?.version ?? 0,
  });
  await decide(ben.actor, submitted.approvalRequestId, 'approve');
  vi.useRealTimers();
});

afterAll(async () => {
  await rm(storageDir, { recursive: true, force: true });
});

describe('R15: go-live on 2026-10-11', () => {
  it('starts the remittance months with October 2026', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-27T10:00:00+08:00'));
    const list = await listRemittances(hr.actor);
    expect(list.months.map((group) => group.month)).toEqual(['2026-10']);
    expect(list.months[0]?.agencies.every((row) => row.status === 'ready')).toBe(true);
  });

  it('is complete with PAY-2026-0001 alone and carries the go-live month note', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-27T10:00:00+08:00'));
    await generateRemittanceReport(hr.actor, { agency: 'sss', month: '2026-10' });
    const page = await getRemittanceReportPage(hr.actor, '2026-10', 'sss');
    expect(page?.sourceRuns.map((run) => [run.number, run.periodText])).toEqual([
      ['PAY-2026-0001', 'Oct 11 – 25, 2026'],
    ]);
    expect(page?.goLiveNote).toBe(
      'Covers only the cut-offs paid in Pulse Talent. Sep 26 – Oct 10, 2026 was paid before go-live: add its contributions and tax to this remittance outside Pulse.',
    );
    expect(page?.report?.employeeCount).toBe(1);
    const report = await RemittanceReportModel.findOne({ agency: 'sss', month: '2026-10' }).lean();
    expect(report?.goLiveNote).toBe('Sep 26 – Oct 10, 2026');
  });

  it('R5: shows the overridden share the run holds, flagged "Differs from the schedule"', async () => {
    const amounts = await showRemittanceAmounts(hr.actor, { agency: 'sss', month: '2026-10' });
    const line = await getPayrollRunLine(runId, A.employeeId);
    if (!line) throw new Error('No line.');
    expect(sumLinesOfKind(line.breakdown, 'sssEmployee')).toBe(0);
    expect(amounts?.rows[0]).toMatchObject({
      employee: { totalCentavos: 0, regularCentavos: 0, mpfCentavos: 0 },
      flags: { differsFromSchedule: true },
    });
    expect(amounts?.rows[0]?.notes).toContain('Differs from the schedule');
    expect(amounts?.totals.employee.totalCentavos).toBe(0);
    expect(amounts?.totals.employer.totalCentavos).toBe(
      sumLinesOfKind(line.breakdown, 'sssEmployer'),
    );
  });
});
