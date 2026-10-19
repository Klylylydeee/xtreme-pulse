import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { Types } from 'mongoose';
import { connectDb } from '@pulse/db';
import { AccessDeniedError, ActionError, type Centavos } from '@pulse/core';
import { decryptSensitive, isEncryptedValue, revealSensitiveField } from '@pulse/core/server';
import {
  PAYROLL_GO_LIVE_REQUIRED_MESSAGE,
  type PayrollBreakdown,
  type PayrollLine,
  payEffectCentavos,
} from '../../payroll-run';
import { addCompensationEntry } from '../compensation/service';
import { registerTalentApprovalTypes } from '../change-requests/service';
import { recomputeDtrOnHolidaysChanged } from '../dtr/listener';
import { registerTalentApprovalSigner, uploadESignature } from '../e-signatures/service';
import {
  approvedLeave,
  auditEntries,
  database,
  decide,
  type Department,
  department,
  finalizePayrollRun,
  holiday,
  notifications,
  type Person,
  person,
  pngFile,
  rawAuditJson,
  seedPayrollSettings,
  setHoliday,
  setLeaveSettings,
  setPositionType,
  setReportingTo,
  storedReimbursement,
  withoutIdsAndDates,
} from '../testing/fixtures';
import { TimeEntryModel, TimesheetModel } from '../timesheets/model';
import { createTimeEntry, getOwnTimesheetView } from '../timesheets/service';
import { submitTimesheet } from '../timesheets/submission';
import { registerTalentSensitiveReveals } from '../sensitive/reveals';
import { runPayrollDrafts } from './job';
import { PayrollRunEmployeeModel, PayrollRunModel } from './model';
import {
  createPayrollDraftRun,
  getPayrollRunBreakdown,
  getPayrollRunView,
  listPayrollRuns,
  PAYROLL_CUT_OFF_INVALID,
  PAYROLL_DRAFT_READY_EVENT,
  PAYROLL_RUN_EXISTS,
  PAYROLL_RUN_NOT_DRAFT,
  recomputePayrollRun,
} from './service';

// The payroll run service tests (docs/TESTING.md#payroll-run-tests, build step 2.9; decisions
// 325–349 in docs/BUILD_PLAN.md), end to end on the database: the Done when (cases P1 and P2 to
// the centavo, from seeded rates, approved timesheets and a draft run created by HR), provisional
// pay (P3, P7), settlements against a finalized run (P4, P5), the contributions across the two
// cut-offs (P6), recomputing (idempotent, concurrent, a non-draft refused), the job's creation
// rule and its notification, the holidays-changed listener (H2), access, encryption and the
// reveal audit. The go-live date is 2026-09-26. Made-up people and figures only (HANDOFF item
// 256): ₱21,750 a month is ₱1,000 a day; ₱26,100 a month is ₱1,200 a day.

const pesos = (amount: number): Centavos => Math.round(amount * 100);
const at = (iso: string) => new Date(iso);

let storageDir: string;
let NET: Department;
let OFF: Department;
let HRD: Department;
let ACC: Department;
let BOD: Department;
let hr: Person;
let hrReader: Person;
let accountant: Person;
let board: Person;
let netWriter: Person;
let boss: Person;

function setNow(iso: string) {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(at(iso));
}

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
  ]);
  await seedPayrollSettings();
  NET = await department('Network', 'NET');
  OFF = await department('Office', 'OFF');
  await setPositionType(OFF, 'standard');
  HRD = await department('Human Resource', 'HR');
  ACC = await department('Accounting', 'ACCT');
  BOD = await department('Board of Directors', 'BOD');
  hr = await person('Hana', 'Reyes', HRD, { talent: 'write' });
  hrReader = await person('Hugo', 'Ramos', HRD, { talent: 'read' });
  accountant = await person('Ana', 'Cruz', ACC, { talent: 'read' });
  board = await person('Ben', 'Lim', BOD, { talent: 'write' });
  netWriter = await person('Nora', 'Diaz', NET, { talent: 'write' });
  boss = await person('Bea', 'Tan', NET);
  for (const approver of [hr, boss]) await uploadESignature(approver.actor, pngFile());
  registerTalentApprovalSigner();
  registerTalentApprovalTypes();
});

afterAll(async () => {
  await rm(storageDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------------------------
// Helpers

let count = 0;
async function employee(
  dept: Department,
  amount: number,
  {
    rateType = 'monthly',
    dateHired = '2025-01-01',
  }: { rateType?: 'monthly' | 'daily'; dateHired?: string } = {},
): Promise<Person> {
  count += 1;
  const p = await person('Test', `Payee${count}`, dept, { dateHired });
  await setReportingTo(p, [boss]);
  const saved = await addCompensationEntry(hr.actor, {
    employeeId: p.employeeId,
    effectiveDate: dateHired,
    basicSalaryCentavos: pesos(amount),
    rateType,
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

/** Submits the timesheet and has the supervisor approve it; HR's step is left waiting. */
async function submitToHr(p: Person, cutOff: string): Promise<string> {
  const { approvalRequestId } = await submitTimesheet(p.actor, {
    timesheetId: await timesheetOf(p, cutOff),
  });
  await decide(boss.actor, approvalRequestId, 'approve');
  return approvalRequestId;
}

async function approve(p: Person, cutOff: string): Promise<void> {
  const requestId = await submitToHr(p, cutOff);
  await decide(hr.actor, requestId, 'approve');
}

/** P1's attendance on the Overtime timesheet, Sep 26 – Oct 10. */
async function p1Attendance(p: Person): Promise<void> {
  await entryOf(p, '2026-09-28', '08:00', '19:00', true);
  for (const day of ['2026-09-29', '2026-09-30']) await entryOf(p, day, '08:00', '17:00');
  await entryOf(p, '2026-10-01', '08:30', '17:00');
  // Oct 2: no entry.
  await entryOf(p, '2026-10-03', '08:00', '12:00', true);
  await entryOf(p, '2026-10-05', '08:00', '17:00');
  await entryOf(p, '2026-10-06', '08:00', '23:00', true);
  for (const day of ['2026-10-07', '2026-10-08', '2026-10-09']) {
    await entryOf(p, day, '08:00', '17:00');
  }
}

/** The ₱350.00 meal receipt on the Sep 26 timesheet (stored after submit, past the claim check). */
async function p1Receipt(p: Person): Promise<void> {
  await storedReimbursement(p, await timesheetOf(p, '2026-09-26'), pesos(350), '2026-09-30');
}

/** Every scheduled work day from `days`, 08:00–17:00. */
async function presentOn(p: Person, days: string[]): Promise<void> {
  for (const day of days) await entryOf(p, day, '08:00', '17:00');
}

async function lineOf(runId: string, p: Person) {
  const line = await PayrollRunEmployeeModel.findOne({
    runId: new Types.ObjectId(runId),
    employeeId: new Types.ObjectId(p.employeeId),
  }).lean();
  if (!line) throw new Error('No line.');
  return line;
}

async function breakdownOf(runId: string, p: Person): Promise<PayrollBreakdown> {
  const line = await lineOf(runId, p);
  const view = await getPayrollRunBreakdown(hr.actor, line._id.toHexString());
  if (!view) throw new Error('No breakdown.');
  return view.breakdown;
}

function amount(b: PayrollBreakdown, key: string, group: PayrollLine['group'] | null = null) {
  return b.lines.find((line) => line.key === key && (group === null || line.group === group))
    ?.amountCentavos;
}

const settlements = (b: PayrollBreakdown) =>
  b.lines
    .filter((line) => line.group === 'settlements')
    .map((line) => [line.key, payEffectCentavos(line)]);

async function runIdFor(periodStart: string): Promise<string> {
  const run = await PayrollRunModel.findOne({
    periodStart: new Date(`${periodStart}T00:00:00+08:00`),
  }).lean();
  if (!run) throw new Error('No run.');
  return run._id.toHexString();
}

// ---------------------------------------------------------------------------------------------

describe('before the go-live date is set', () => {
  it('creates no run, and says why', async () => {
    setNow('2026-10-19T10:00:00+08:00');
    await expect(createPayrollDraftRun(hr.actor, { periodStart: '2026-09-26' })).rejects.toThrow(
      PAYROLL_GO_LIVE_REQUIRED_MESSAGE,
    );
    const job = await runPayrollDrafts(at('2026-10-19T05:00:00+08:00'));
    expect(job).toMatchObject({ goLiveDate: null, created: null, recomputed: 0 });
    const list = await listPayrollRuns(hr.actor);
    expect(list).toMatchObject({
      runs: [],
      goLiveDate: null,
      goLiveMissingMessage: PAYROLL_GO_LIVE_REQUIRED_MESSAGE,
      creatable: [],
    });
    expect(await PayrollRunModel.countDocuments()).toBe(0);
  });
});

describe('the draft run for Sep 26 – Oct 10, 2026 (the Done when)', () => {
  let A: Person; // P1, approved
  let B: Person; // P2, approved
  let C: Person; // P3: P1's attendance, waiting for HR
  let D: Person; // P1, approved; later an approved SL on Oct 2 (P5)
  let G: Person; // P7: hired Mon Oct 5, no timesheet
  let noSalary: Person;
  let separatedEarlier: Person;
  let runId: string;

  beforeAll(async () => {
    setNow('2026-10-19T10:00:00+08:00');
    await setLeaveSettings({ goLiveDate: '2026-09-26' });
    A = await employee(NET, 21750);
    B = await employee(OFF, 26100);
    C = await employee(NET, 21750);
    D = await employee(NET, 21750);
    G = await employee(NET, 21750, { dateHired: '2026-10-05' });
    noSalary = await person('No', 'Salary', NET, { dateHired: '2025-01-01' });
    separatedEarlier = await person('Sep', 'Arated', NET, { status: 'Resigned' });
    await addCompensationEntry(hr.actor, {
      employeeId: separatedEarlier.employeeId,
      effectiveDate: '2024-01-01',
      basicSalaryCentavos: pesos(21750),
      rateType: 'monthly',
      minimumWageEarner: false,
      reason: 'Made-up test salary',
    });

    for (const p of [A, C, D]) await p1Attendance(p);
    // P2: Standard timesheet, approved VL Oct 8 – 9 with one day paid.
    await presentOn(B, ['2026-09-28']);
    await entryOf(B, '2026-09-29', '08:00', '19:00', true);
    await entryOf(B, '2026-09-30', '08:00', '16:00');
    await presentOn(B, ['2026-10-01', '2026-10-02']);
    await entryOf(B, '2026-10-03', '08:00', '12:00', true);
    await presentOn(B, ['2026-10-05', '2026-10-06', '2026-10-07']);
    await approvedLeave(B, 'vacation', '2026-10-08', '2026-10-09', 2);

    for (const p of [A, B, D]) await approve(p, '2026-09-26');
    await submitToHr(C, '2026-09-26');
    for (const p of [A, C, D]) await p1Receipt(p);
    vi.useRealTimers();
  });

  it('lists the ended cut-off for HR, and refuses one that has not ended', async () => {
    setNow('2026-10-19T10:00:00+08:00');
    const list = await listPayrollRuns(hr.actor);
    expect(list.canCompute).toBe(true);
    expect(list.firstPeriodStart).toBe('2026-09-26');
    expect(list.creatable.map((c) => c.periodStart)).toEqual(['2026-09-26']);
    await expect(createPayrollDraftRun(hr.actor, { periodStart: '2026-10-11' })).rejects.toThrow(
      PAYROLL_CUT_OFF_INVALID,
    );
    await expect(createPayrollDraftRun(hr.actor, { periodStart: '2026-09-27' })).rejects.toThrow(
      PAYROLL_CUT_OFF_INVALID,
    );
    await expect(createPayrollDraftRun(hr.actor, { periodStart: '2026-09-11' })).rejects.toThrow(
      PAYROLL_CUT_OFF_INVALID,
    );
  });

  it('computes P1 and P2 to the centavo from the seeded rates', async () => {
    setNow('2026-10-19T10:00:00+08:00');
    const created = await createPayrollDraftRun(hr.actor, { periodStart: '2026-09-26' });
    runId = created.id;
    expect(created.number).toBe('PAY-2026-0001');

    const p1 = await breakdownOf(runId, A);
    expect(p1.facts).toMatchObject({
      provisional: false,
      baseDays: 10,
      dailyRateCentavos: pesos(1000),
      hourlyRateCentavos: pesos(125),
    });
    expect(amount(p1, 'basicPay')).toBe(pesos(10875));
    expect(amount(p1, 'overtimeOrdinary')).toBe(pesos(1250));
    expect(amount(p1, 'restDayWork')).toBe(pesos(650));
    expect(amount(p1, 'nightDifferential')).toBe(pesos(12.5));
    expect(amount(p1, 'allowance:internet')).toBe(pesos(500));
    expect(amount(p1, 'reimbursement')).toBe(pesos(350));
    expect(amount(p1, 'absence')).toBe(pesos(1000));
    expect(amount(p1, 'late')).toBe(pesos(62.5));
    expect(amount(p1, 'sssEmployee')).toBe(pesos(550));
    expect(amount(p1, 'philhealthEmployee')).toBe(pesos(271.88));
    expect(amount(p1, 'pagibigEmployee')).toBe(pesos(100));
    expect(p1.taxableCompensationCentavos).toBe(pesos(10803.12));
    expect(amount(p1, 'withholdingTax')).toBe(pesos(57.92));
    expect(p1.totals).toMatchObject({
      grossCentavos: pesos(13637.5),
      deductionsCentavos: pesos(2042.3),
      netPayCentavos: pesos(11595.2),
    });
    expect(amount(p1, 'sssEmployer')).toBe(pesos(1100));
    expect(amount(p1, 'sssEc')).toBe(pesos(15));
    expect(amount(p1, 'philhealthEmployer')).toBe(pesos(271.88));
    expect(amount(p1, 'pagibigEmployer')).toBe(pesos(100));

    const p2 = await breakdownOf(runId, B);
    expect(p2.facts).toMatchObject({ offsetEarnedMinutes: 360, timesheetType: 'standard' });
    expect(amount(p2, 'basicPay')).toBe(pesos(13050));
    expect(amount(p2, 'allowance:internet')).toBe(pesos(500));
    expect(amount(p2, 'undertime')).toBe(pesos(150));
    expect(amount(p2, 'leaveWithoutPay')).toBe(pesos(1200));
    expect(amount(p2, 'sssEmployee')).toBe(pesos(650));
    expect(amount(p2, 'philhealthEmployee')).toBe(pesos(326.25));
    expect(amount(p2, 'pagibigEmployee')).toBe(pesos(100));
    expect(p2.taxableCompensationCentavos).toBe(pesos(10623.75));
    expect(p2.taxCentavos).toBe(pesos(31.01));
    expect(p2.totals).toMatchObject({
      grossCentavos: pesos(13550),
      deductionsCentavos: pesos(2457.26),
      netPayCentavos: pesos(11092.74),
    });
    expect(p2.lines.some((line) => line.kind === 'overtimeOrdinary')).toBe(false);
  });

  it('pays a timesheet not fully approved basic pay only (P3), and prorates a hire (P7)', async () => {
    const p3 = await breakdownOf(runId, C);
    expect(p3.facts).toMatchObject({ provisional: true, timesheetStatus: 'pendingHr' });
    expect(p3.lines.filter((line) => line.side === 'earning').map((line) => line.key)).toEqual([
      'basicPay',
      'allowance:internet',
    ]);
    expect(p3.taxableCompensationCentavos).toBe(pesos(9953.12));
    expect(p3.taxCentavos).toBe(0);
    expect(p3.totals.netPayCentavos).toBe(pesos(10453.12));
    const line = await lineOf(runId, C);
    expect(line).toMatchObject({ timesheetApproved: false, timesheetStatus: 'pendingHr' });

    const p7 = await breakdownOf(runId, G);
    expect(amount(p7, 'basicPay')).toBe(pesos(5000));
    expect(amount(p7, 'allowance:internet')).toBe(pesos(250));
  });

  it('stores the run, its counts and the people left out, with every amount encrypted', async () => {
    const run = await database()
      .collection('payrollRuns')
      .findOne({ _id: new Types.ObjectId(runId) });
    expect(run).toMatchObject({
      status: 'draft',
      kind: 'regular',
      cutOffKey: 'midMonth',
      contributionMonth: '2026-10',
      employeeCount: 5,
      version: 1,
      computedBy: new Types.ObjectId(hr.userId),
    });
    const leftOut = (run?.leftOut as { employeeId: Types.ObjectId; reason: string }[]).map((e) =>
      e.employeeId.toHexString(),
    );
    expect(leftOut).toContain(noSalary.employeeId);
    expect(leftOut).toContain(hr.employeeId);
    expect(leftOut).not.toContain(separatedEarlier.employeeId);
    expect(leftOut).not.toContain(A.employeeId);
    expect((run?.settingVersions as { key: string }[]).map((v) => v.key)).toEqual(
      expect.arrayContaining(['talent.payrollSettings', 'talent.payrollRunSettings']),
    );
    for (const value of Object.values(run?.totals ?? {})) {
      expect(isEncryptedValue(value)).toBe(true);
    }
    const lines = await database()
      .collection('payrollRunEmployees')
      .find({ runId: new Types.ObjectId(runId) })
      .toArray();
    expect(lines).toHaveLength(5);
    for (const line of lines) {
      for (const field of ['grossCentavos', 'deductionsCentavos', 'netPayCentavos', 'breakdown']) {
        expect(isEncryptedValue(line[field]), field).toBe(true);
      }
    }
    const raw = withoutIdsAndDates(JSON.stringify(lines));
    expect(raw).not.toContain('1159520');
    expect(raw).not.toContain('10875');
    // The totals are the lines' sums.
    const withTotals = await PayrollRunModel.findById(runId)
      .select('+totals.netPayCentavos +totals.reimbursementsCentavos')
      .lean();
    const nets = await Promise.all(
      lines.map(async (line) => Number(await decryptSensitive(line.netPayCentavos))),
    );
    expect(await decryptSensitive(withTotals?.totals.netPayCentavos)).toBe(
      nets.reduce((a, b) => a + b, 0),
    );
    expect(await decryptSensitive(withTotals?.totals.reimbursementsCentavos)).toBe(pesos(350) * 2);

    // One `create` entry, with no amount.
    const audit = await auditEntries('talent.payrollRun');
    expect(audit.map((entry) => entry.action)).toEqual(['create']);
    expect(audit[0]?.record.label).toBe('PAY-2026-0001 · Sep 26 – Oct 10');
    const json = withoutIdsAndDates(await rawAuditJson());
    expect(json).not.toContain('1159520');
    expect(json).not.toContain('1087500');
  });

  it('refuses a second run for the cut-off', async () => {
    setNow('2026-10-19T10:00:00+08:00');
    await expect(createPayrollDraftRun(hr.actor, { periodStart: '2026-09-26' })).rejects.toThrow(
      PAYROLL_RUN_EXISTS,
    );
    expect((await listPayrollRuns(hr.actor)).creatable).toEqual([]);
  });

  it('recomputes idempotently, even twice at once', async () => {
    setNow('2026-10-19T11:00:00+08:00');
    const before = await breakdownOf(runId, A);
    const result = await recomputePayrollRun(hr.actor, { runId });
    expect(result.version).toBe(2);
    expect(await breakdownOf(runId, A)).toEqual(before);

    const both = await Promise.all([
      recomputePayrollRun(hr.actor, { runId }),
      recomputePayrollRun(hr.actor, { runId }),
    ]);
    expect(both.map((r) => r.version).sort()).toEqual([3, 4]);
    expect(await PayrollRunEmployeeModel.countDocuments({ runId: new Types.ObjectId(runId) })).toBe(
      5,
    );
    expect(await breakdownOf(runId, A)).toEqual(before);
    const audit = await auditEntries('talent.payrollRun');
    expect(audit.map((entry) => [entry.action, entry.reason ?? null])).toEqual([
      ['create', null],
      ['update', 'Recomputed'],
      ['update', 'Recomputed'],
      ['update', 'Recomputed'],
    ]);
  });

  it('lets HR, Accounting and the System Administrator see runs, and HR alone compute', async () => {
    setNow('2026-10-19T11:00:00+08:00');
    for (const viewer of [hr, hrReader, accountant]) {
      expect((await listPayrollRuns(viewer.actor)).runs).toHaveLength(1);
    }
    expect((await listPayrollRuns(accountant.actor)).canCompute).toBe(false);
    expect((await listPayrollRuns(hrReader.actor)).canCompute).toBe(false);
    for (const outsider of [board, netWriter, boss, A]) {
      await expect(listPayrollRuns(outsider.actor)).rejects.toBeInstanceOf(AccessDeniedError);
      await expect(getPayrollRunView(outsider.actor, runId)).rejects.toBeInstanceOf(
        AccessDeniedError,
      );
    }
    for (const notHr of [accountant, hrReader, netWriter, board]) {
      await expect(recomputePayrollRun(notHr.actor, { runId })).rejects.toBeInstanceOf(
        AccessDeniedError,
      );
      await expect(
        createPayrollDraftRun(notHr.actor, { periodStart: '2026-09-26' }),
      ).rejects.toBeInstanceOf(AccessDeniedError);
    }
  });

  it('sends no amount until "Show amounts", which is audit-logged first', async () => {
    const plain = await getPayrollRunView(accountant.actor, runId);
    expect(plain).toMatchObject({ amountsShown: false, totals: null, canRecompute: false });
    expect(plain?.people.every((row) => row.netPayCentavos === null)).toBe(true);
    expect(plain?.tiles).toMatchObject({ employees: 5, timesheetNotApproved: 2, negativeNet: 0 });
    expect(plain?.people.find((row) => row.employeeId === C.employeeId)).toMatchObject({
      provisional: true,
      settles: false,
    });
    expect(plain?.leftOut.find((row) => row.employeeId === noSalary.employeeId)).toMatchObject({
      reasonLabel: 'No salary on file',
    });
    const reveals = async () =>
      (await auditEntries('talent.payrollRun')).filter((entry) => entry.action === 'reveal');
    expect(await reveals()).toHaveLength(0);

    // If the entry can't be written, nothing is decrypted or sent.
    const unloggable = { ...accountant.actor, email: 'x'.repeat(400) };
    await expect(getPayrollRunView(unloggable, runId, { showAmounts: true })).rejects.toThrow();
    expect(await reveals()).toHaveLength(0);

    const shown = await getPayrollRunView(accountant.actor, runId, { showAmounts: true });
    expect(shown?.amountsShown).toBe(true);
    expect(shown?.people.find((row) => row.employeeId === A.employeeId)?.netPayCentavos).toBe(
      pesos(11595.2),
    );
    expect(shown?.totals?.reimbursementsCentavos).toBe(pesos(700));
    const entries = await reveals();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      fields: ['amounts'],
      actorId: new Types.ObjectId(accountant.userId),
    });

    // A breakdown: a reveal on its line, first.
    const line = await lineOf(runId, A);
    await expect(getPayrollRunBreakdown(unloggable, line._id.toHexString())).rejects.toThrow();
    const lineReveals = async () =>
      (await auditEntries('talent.payrollRunEmployee')).filter((e) => e.action === 'reveal');
    const already = (await lineReveals()).length;
    const opened = await getPayrollRunBreakdown(accountant.actor, line._id.toHexString());
    expect(opened?.groups.map((group) => group.group)).toEqual([
      'earnings',
      'deductions',
      'employerShares',
    ]);
    const after = await lineReveals();
    expect(after).toHaveLength(already + 1);
    expect(after.at(-1)).toMatchObject({ fields: ['breakdown'] });

    // A line asked for under another run is refused before any reveal is written.
    const otherRun = new Types.ObjectId().toHexString();
    expect(
      await getPayrollRunBreakdown(accountant.actor, line._id.toHexString(), { runId: otherRun }),
    ).toBeNull();
    expect(
      await getPayrollRunBreakdown(accountant.actor, line._id.toHexString(), { runId: 'nope' }),
    ).toBeNull();
    expect(await lineReveals()).toHaveLength(already + 1);
    const sameRun = await getPayrollRunBreakdown(accountant.actor, line._id.toHexString(), {
      runId,
    });
    expect(sameRun?.runId).toBe(runId);
    expect(await lineReveals()).toHaveLength(already + 2);

    // A draft's amounts never come out through the generic reveal, even for HR.
    registerTalentSensitiveReveals();
    await expect(
      revealSensitiveField({
        actor: hr.actor,
        ownerType: 'talent.payrollRunEmployee',
        ownerId: line._id.toHexString(),
        field: 'netPay',
      }),
    ).rejects.toBeInstanceOf(ActionError);
    expect(await lineReveals()).toHaveLength(already + 2);
    expect(withoutIdsAndDates(await rawAuditJson())).not.toContain('1159520');
  });

  describe('the next cut-off, Oct 11 – 25 (P4, P5, P6), after Sep 26 – Oct 10 is finalized', () => {
    let nextId: string;

    beforeAll(async () => {
      setNow('2026-10-19T12:00:00+08:00');
      await finalizePayrollRun(runId);
      // P4: C's timesheet approved after the run was finalized.
      const pending = await database()
        .collection('timesheets')
        .findOne({ employeeId: new Types.ObjectId(C.employeeId) });
      await decide(hr.actor, String(pending?.approvalRequestId), 'approve');
      // P5: an approved SL covers Oct 2 for D.
      await approvedLeave(D, 'sick', '2026-10-02', '2026-10-02', 2);
      // P6: A is present every day of Oct 11 – 25.
      setNow('2026-10-27T10:00:00+08:00');
      await presentOn(A, [
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
      ]);
      await approve(A, '2026-10-11');
      vi.useRealTimers();
    });

    it('refuses to recompute the finalized run', async () => {
      await expect(recomputePayrollRun(hr.actor, { runId })).rejects.toThrow(PAYROLL_RUN_NOT_DRAFT);
      await expect(recomputePayrollRun(hr.actor, { runId })).rejects.toBeInstanceOf(ActionError);
    });

    it('settles the earlier cut-off item by item against what was finalized', async () => {
      setNow('2026-10-27T10:00:00+08:00');
      nextId = (await createPayrollDraftRun(hr.actor, { periodStart: '2026-10-11' })).id;

      // P4: everything that waited, now approved.
      const c = await breakdownOf(nextId, C);
      expect(settlements(c)).toEqual(
        expect.arrayContaining([
          ['overtimeOrdinary', pesos(1250)],
          ['restDayWork', pesos(650)],
          ['nightDifferential', pesos(12.5)],
          ['reimbursement', pesos(350)],
          ['absence', -pesos(1000)],
          ['late', -pesos(62.5)],
        ]),
      );
      expect(settlements(c)).toHaveLength(6);
      expect(c.settledPeriods).toEqual(['2026-09-26']);
      expect((await lineOf(nextId, C)).settledPeriods.map((d) => d.toISOString())).toHaveLength(2);

      // P5: the absence reversed.
      expect(settlements(await breakdownOf(nextId, D))).toEqual([['absence', pesos(1000)]]);

      // P6: A, nothing to settle; the month's contributions less the mid-month run's.
      const a = await breakdownOf(nextId, A);
      expect(settlements(a)).toEqual([]);
      expect(a.compensationForContributionsCentavos).toBe(pesos(10875));
      expect(a.contributions.method).toBe('remainder');
      expect(a.contributions.monthCompensationCentavos).toBe(pesos(22600));
      expect(a.contributions.sss.mscCentavos).toBe(pesos(22500));
      expect(amount(a, 'sssEmployee')).toBe(pesos(575));
      expect(amount(a, 'philhealthEmployee')).toBe(pesos(271.87));
      expect(amount(a, 'pagibigEmployee')).toBe(pesos(100));
      expect(a.taxableCompensationCentavos).toBe(pesos(9928.13));
      expect(a.taxCentavos).toBe(0);

      const view = await getPayrollRunView(hr.actor, nextId);
      expect(view?.people.find((row) => row.employeeId === C.employeeId)?.settles).toBe(true);
      expect(view?.number).toBe('PAY-2026-0002');
    });
  });

  describe('the job and the holidays-changed listener (H2), Nov 26 – Dec 25', () => {
    let F: Person;
    let nov30: string;
    let novId: string;

    beforeAll(async () => {
      setNow('2026-12-26T09:00:00+08:00');
      nov30 = await holiday('2026-11-30', { status: 'draft', name: 'Made-up Regular Day' });
      await holiday('2026-12-08', { type: 'specialNonWorking', name: 'Made-up Special Day' });
      F = await employee(NET, 21750);
      // Present every work day of Nov 26 – Dec 10 but Nov 30 (still a draft holiday) and Dec 8.
      await presentOn(F, [
        '2026-11-26',
        '2026-11-27',
        '2026-12-01',
        '2026-12-02',
        '2026-12-03',
        '2026-12-04',
        '2026-12-07',
        '2026-12-09',
        '2026-12-10',
      ]);
      await approve(F, '2026-11-26');
      novId = (await createPayrollDraftRun(hr.actor, { periodStart: '2026-11-26' })).id;
      vi.useRealTimers();
    });

    it('deducts the draft holiday as an absence', async () => {
      const f = await breakdownOf(novId, F);
      expect(amount(f, 'absence')).toBe(pesos(1000));
      await finalizePayrollRun(novId);
    });

    it('waits for the timesheets until the deadline, then creates the draft once and tells HR', async () => {
      // Dec 26: the deadline day of Dec 11 – 25, and the timesheets aren't all approved.
      const waiting = await runPayrollDrafts(at('2026-12-26T05:00:00+08:00'));
      expect(waiting).toMatchObject({
        goLiveDate: '2026-09-26',
        latestPeriodStart: '2026-12-11',
        created: null,
        waiting: 'timesheets',
      });
      expect(
        await PayrollRunModel.exists({ periodStart: new Date('2026-12-11T00:00:00+08:00') }),
      ).toBeNull();

      setNow('2026-12-27T05:00:00+08:00');
      const draftsBefore = await PayrollRunModel.countDocuments({ status: 'draft' });
      const created = await runPayrollDrafts(at('2026-12-27T05:00:00+08:00'));
      expect(created.created).toMatch(/^PAY-2026-\d{4}$/);
      expect(created.recomputed).toBe(draftsBefore);
      const decId = await runIdFor('2026-12-11');
      const run = await PayrollRunModel.findById(decId).lean();
      expect(run).toMatchObject({ status: 'draft', computedBy: null, cutOffKey: 'endOfMonth' });
      const sent = await notifications({ event: PAYROLL_DRAFT_READY_EVENT });
      expect(sent.map((n) => n.recipientUserId.toHexString()).sort()).toEqual(
        [hr.userId, hrReader.userId].sort(),
      );
      expect(sent[0]).toMatchObject({
        title: 'Draft payroll for Dec 11 – 25 is ready to review',
        href: `/talent/payroll/${decId}`,
      });
      expect(JSON.stringify(sent)).not.toMatch(/₱|\d{3},\d{3}/);

      // Again: nothing new, one notification, every draft recomputed.
      const again = await runPayrollDrafts(at('2026-12-27T05:00:00+08:00'));
      expect(again).toMatchObject({
        created: null,
        waiting: 'exists',
        recomputed: draftsBefore + 1,
      });
      expect(await notifications({ event: PAYROLL_DRAFT_READY_EVENT })).toHaveLength(2);
      const audit = (await auditEntries('talent.payrollRun')).filter(
        (entry) => String(entry.record.id) === decId,
      );
      expect(audit.map((entry) => [entry.action, entry.actorId])).toEqual([
        ['create', null],
        ['update', null],
      ]);
    });

    it('recomputes the drafts after a holiday is confirmed, settling the finalized period (H2)', async () => {
      setNow('2026-12-27T09:00:00+08:00');
      const decId = await runIdFor('2026-12-11');
      const octId = await runIdFor('2026-10-11');
      const [decBefore, octBefore] = await Promise.all([
        PayrollRunModel.findById(decId).lean(),
        PayrollRunModel.findById(octId).lean(),
      ]);
      expect(settlements(await breakdownOf(decId, F))).toEqual([]);

      await setHoliday(nov30, { status: 'confirmed' });
      const result = await recomputeDtrOnHolidaysChanged({ dates: ['2026-11-30'] });
      expect(result.payrollDrafts).toBeGreaterThanOrEqual(1);

      const [decAfter, octAfter] = await Promise.all([
        PayrollRunModel.findById(decId).lean(),
        PayrollRunModel.findById(octId).lean(),
      ]);
      expect(decAfter?.version).toBe((decBefore?.version ?? 0) + 1);
      // Oct 11 – 25's window (Sep 26 – Oct 25, and the cut-off before) doesn't hold Nov 30.
      expect(octAfter?.version).toBe(octBefore?.version);
      const f = await breakdownOf(decId, F);
      expect(settlements(f)).toEqual([['absence', pesos(1000)]]);
      expect(f.lines.find((line) => line.group === 'settlements')?.label).toBe(
        'Absences · Nov 26 – Dec 10',
      );
      // The finalized run is never recomputed.
      expect((await PayrollRunModel.findById(novId).lean())?.status).toBe('finalized');
    });
  });
});
