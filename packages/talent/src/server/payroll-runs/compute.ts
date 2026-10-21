import { type ClientSession, Types } from 'mongoose';
import { connectDb } from '@pulse/db';
import { ActionError, addDays, type BusinessDate, type Centavos } from '@pulse/core';
import {
  type ConfigVersion,
  decryptSensitive,
  type EmployeeIdentity,
  type IdentityActor,
  listConfigVersions,
  listConfirmedHolidays,
  listEmployeeIdentities,
  resolveModuleAccess,
} from '@pulse/core/server';
import type { DtrTimeOffInput } from '../../dtr/compute';
import { DEFAULT_WORK_REGION, type WorkRegion } from '../../fixed-sets';
import type { CutOffPeriod } from '../../payroll/lookups';
import { minimumWageForRegion } from '../../payroll/minimum-wage';
import type { OnboardingGateStatus } from '../../onboarding/gates';
import { type PayrollRunSettings, SEED_PAYROLL_RUN_SETTINGS } from '../../payroll/run-settings';
import type {
  AllowanceTypes,
  DeMinimisLimits,
  MinimumWages,
  PagibigContributions,
  PayrollSettings,
  PhilhealthContributions,
  PremiumRates,
  SssContributions,
  WithholdingTaxSemiMonthly,
} from '../../payroll/schemas';
import {
  attendanceItemsPaidFor,
  computePayrollLine,
  computePeriodPay,
  contributionMonthOf,
  countPayrollFlags,
  daysBelowMinimumWage,
  derivePayrollLineFlags,
  firstPayrollCutOff,
  livePayrollManualEntries,
  midMonthFiguresOf,
  parsePayrollBreakdown,
  type PayrollAllowanceEntry,
  type PayrollAttendanceItem,
  type PayrollBreakdown,
  type PayrollCalendarDay,
  payrollCalendar,
  type PayrollEarlierPeriodInput,
  type PayrollFlagCounts,
  type PayrollLeftOutReason,
  type PayrollLineFlag,
  type PayrollManualEntryInput,
  type PayrollManualEntryKind,
  type PayrollMidMonthFigures,
  type PayrollPeriodInput,
  type PayrollPriorDay,
  payrollRunMembership,
  type PayrollSalaryEntry,
  type PayrollTimesheetInput,
  type PayrollTotals,
  previousCutOff,
  settlementCutOffs,
  sumAttendanceItems,
} from '../../payroll-run';
import type { NightWindow } from '../../timesheets/compute';
import { type EffectiveVersion, versionOn } from '../../timesheets/schedule';
import type { TimesheetSettings, WorkSchedule } from '../../timesheets/schemas';
import { AllowanceAssignmentModel } from '../allowances/model';
import { CompensationEntryModel } from '../compensation/model';
import { type DtrSources, dtrOf } from '../dtr/service';
import { workRegionsOf } from '../minimum-wage/service';
import { deriveOnboarding } from '../onboarding/service';
import {
  PAYROLL_MANUAL_ENTRY_AMOUNT_SELECT,
  type PayrollManualEntryDocument,
  PayrollManualEntryModel,
} from '../payroll-review/model';
import {
  ALLOWANCE_TYPES_SETTING,
  DE_MINIMIS_LIMITS_SETTING,
  leaveSettingsOn,
  MINIMUM_WAGES_SETTING,
  PAGIBIG_CONTRIBUTIONS_SETTING,
  PAYROLL_RUN_SETTINGS_SETTING,
  PAYROLL_SETTINGS_SETTING,
  PHILHEALTH_CONTRIBUTIONS_SETTING,
  PREMIUM_RATES_SETTING,
  SSS_CONTRIBUTIONS_SETTING,
  TIMESHEET_SETTINGS_SETTING,
  WITHHOLDING_TAX_SEMI_MONTHLY_SETTING,
  WORK_SCHEDULE_SETTING,
} from '../payroll-settings/settings';
import { ReimbursementModel } from '../reimbursements/model';
import { dayOf, instantOf } from '../shared';
import { approvedTimeOffInputs } from '../time-off/days';
import {
  type TimeEntryDocument,
  type TimesheetDocument,
  TimeEntryModel,
  TimesheetModel,
} from '../timesheets/model';
import { periodOrNull } from '../timesheets/periods';
import { type LoadedAssignment, loadWorkScheduleAssignments } from '../work-schedules/service';
import {
  type PayrollRunDocument,
  PayrollRunEmployeeModel,
  PayrollRunModel,
  type PayrollRunSettingVersion,
} from './model';

// Spec: docs/modules/talent.md#payroll-run-computation-build-step-29 ("Who is in a run", "Rates",
// "Versions used", "Settling earlier cut-offs", "Government contributions"; decisions 327–339 in
// docs/BUILD_PLAN.md) — the run service's actorless loaders and the computation of one run's
// lines with the pure engine (../../payroll-run/). Nothing here writes; ./service.ts stores the
// result in a transaction.
//
// Step 2.10 (docs/modules/talent.md#payroll-review-approval-and-payslips-build-step-210, "Review
// flags", "Manual entries"; decisions 352–358): a stored run's live manual entries (the latest of
// each chain, not removed) are applied to their employee's line, and each line's review flags are
// derived from the onboarding status on the day of the compute (`includeInPayroll`), the daily
// minimum wage in effect on each day for the employee's current work region, the timesheet, net
// pay and the entries the engine couldn't apply. A live entry whose employee has no line is stale
// (`employeeNotInRun`) and counted in `flagCounts.manualEntryStale`.
//
// Performance (HANDOFF › 2.9 notes, "Risks"): a run reconciles up to `adjustmentLookbackCutOffs`
// earlier cut-offs per employee. Every setting's versions, the holidays and the finalized runs
// are loaded once per run, and each source is loaded once per run for every employee together
// (salaries, allowances, timesheets, entries, reimbursements, finalized and mid-month lines), so
// only the work schedule assignments and the approved time off are read per employee, once for
// the whole window. Each period's DTR is computed in memory, once per employee and period.
//
// Never log anything from here: the decrypted salaries, allowances and breakdowns are pay amounts.

/** The refusal when a payroll setting has no version for a date the run needs. */
export const PAYROLL_SETTINGS_MISSING =
  'A payroll setting has no version in effect for this cut-off. Run pnpm seed:admin or add a version in Payroll settings.';

/** The job and the listener read Core's identities with Talent Read and no employee. */
export const PAYROLL_READER: IdentityActor = {
  employee: null,
  moduleAccess: resolveModuleAccess({
    isSystemAdministrator: false,
    moduleAccess: { talent: 'read' },
  }),
};

// ---------------------------------------------------------------------------------------------
// Settings

/** Every version of every setting a run reads, loaded once. */
export interface PayrollRunVersions {
  payroll: ConfigVersion<PayrollSettings>[];
  run: ConfigVersion<PayrollRunSettings>[];
  sss: ConfigVersion<SssContributions>[];
  philhealth: ConfigVersion<PhilhealthContributions>[];
  pagibig: ConfigVersion<PagibigContributions>[];
  withholding: ConfigVersion<WithholdingTaxSemiMonthly>[];
  premiumRates: ConfigVersion<PremiumRates>[];
  deMinimisLimits: ConfigVersion<DeMinimisLimits>[];
  minimumWages: ConfigVersion<MinimumWages>[];
  allowanceTypes: ConfigVersion<AllowanceTypes>[];
  workSchedule: ConfigVersion<WorkSchedule>[];
  timesheetSettings: ConfigVersion<TimesheetSettings>[];
}

export async function loadPayrollRunVersions(): Promise<PayrollRunVersions> {
  await connectDb();
  const [
    payroll,
    run,
    sss,
    philhealth,
    pagibig,
    withholding,
    premiumRates,
    deMinimisLimits,
    minimumWages,
    allowanceTypes,
    workSchedule,
    timesheetSettings,
  ] = await Promise.all([
    listConfigVersions(PAYROLL_SETTINGS_SETTING),
    listConfigVersions(PAYROLL_RUN_SETTINGS_SETTING),
    listConfigVersions(SSS_CONTRIBUTIONS_SETTING),
    listConfigVersions(PHILHEALTH_CONTRIBUTIONS_SETTING),
    listConfigVersions(PAGIBIG_CONTRIBUTIONS_SETTING),
    listConfigVersions(WITHHOLDING_TAX_SEMI_MONTHLY_SETTING),
    listConfigVersions(PREMIUM_RATES_SETTING),
    listConfigVersions(DE_MINIMIS_LIMITS_SETTING),
    listConfigVersions(MINIMUM_WAGES_SETTING),
    listConfigVersions(ALLOWANCE_TYPES_SETTING),
    listConfigVersions(WORK_SCHEDULE_SETTING),
    listConfigVersions(TIMESHEET_SETTINGS_SETTING),
  ]);
  return {
    payroll,
    run,
    sss,
    philhealth,
    pagibig,
    withholding,
    premiumRates,
    deMinimisLimits,
    minimumWages,
    allowanceTypes,
    workSchedule,
    timesheetSettings,
  };
}

/** The version in effect on `day`; refuses when none is (the seed hasn't run). */
function required<T>(versions: readonly ConfigVersion<T>[], day: BusinessDate): ConfigVersion<T> {
  const found = versionOn(versions, day);
  if (!found) throw new ActionError(PAYROLL_SETTINGS_MISSING);
  return found;
}

/** `talent.payrollRunSettings` on `day`, or the seeded value (null date) before any version. */
function runSettingsOn(
  versions: PayrollRunVersions,
  day: BusinessDate,
): { value: PayrollRunSettings; effectiveFrom: BusinessDate | null } {
  const found = versionOn(versions.run, day);
  return found
    ? { value: found.value, effectiveFrom: found.effectiveFrom }
    : { value: structuredClone(SEED_PAYROLL_RUN_SETTINGS), effectiveFrom: null };
}

/** The versions in effect on any day from `from` to `to` (for the settings read on each day). */
function versionsDuring<T>(
  versions: readonly EffectiveVersion<T>[],
  from: BusinessDate,
  to: BusinessDate,
): EffectiveVersion<T>[] {
  const first = versionOn(versions, from);
  const later = versions.filter((v) => v.effectiveFrom > from && v.effectiveFrom <= to);
  return [...(first ? [first] : []), ...later];
}

/** The first day of a pay date's contribution month. */
const firstOfMonth = (payDate: BusinessDate): BusinessDate => `${contributionMonthOf(payDate)}-01`;

// ---------------------------------------------------------------------------------------------
// The cut-offs

/** The first payroll cut-off, or null while the go-live date is null (decision 327). */
export async function loadFirstPayrollCutOff(
  versions: Pick<PayrollRunVersions, 'payroll'>,
  today: BusinessDate,
): Promise<CutOffPeriod | null> {
  const { goLiveDate } = await leaveSettingsOn(today);
  return firstPayrollCutOff(goLiveDate, versions.payroll);
}

/** The cut-off that starts on `periodStart`, or null when no cut-off starts that day. */
export function cutOffStartingOn(
  periodStart: BusinessDate,
  versions: Pick<PayrollRunVersions, 'payroll'>,
): CutOffPeriod | null {
  const period = periodOrNull(periodStart, versions.payroll);
  return period && period.start === periodStart ? period : null;
}

// ---------------------------------------------------------------------------------------------
// Sources, loaded once per run for every employee

interface EmployeeSources {
  identity: EmployeeIdentity;
  salaries: PayrollSalaryEntry[];
  allowanceEntries: PayrollAllowanceEntry[];
  assignments: LoadedAssignment[];
  entries: TimeEntryDocument[];
  timeOff: DtrTimeOffInput[];
  /** By period start. */
  timesheets: Map<BusinessDate, TimesheetDocument>;
  region: WorkRegion;
  /** The finalized regular runs' lines for this employee, decrypted. */
  finalized: { payDate: BusinessDate; breakdown: PayrollBreakdown }[];
  midMonth: PayrollMidMonthFigures | null;
  /** Step 2.10: the line's live manual entries, oldest first. */
  manualEntries: PayrollManualEntryInput[];
  /** Step 2.10: the onboarding item states on the day of the compute. */
  onboarding: OnboardingGateStatus;
}

const objectIds = (ids: readonly string[]) => ids.map((id) => new Types.ObjectId(id));

function groupBy<T>(rows: readonly T[], key: (row: T) => string): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const row of rows) {
    const k = key(row);
    const list = map.get(k);
    if (list) list.push(row);
    else map.set(k, [row]);
  }
  return map;
}

async function decryptCentavos(value: unknown): Promise<Centavos | null> {
  if (value === undefined || value === null) return null;
  const decrypted = await decryptSensitive(value);
  return typeof decrypted === 'number' && Number.isSafeInteger(decrypted) ? decrypted : null;
}

/** Every employee's salary history, decrypted (or with 0 amounts for membership only). */
export async function loadSalaries(
  employeeIds: readonly string[],
  { withAmounts = true }: { withAmounts?: boolean } = {},
): Promise<Map<string, PayrollSalaryEntry[]>> {
  if (employeeIds.length === 0) return new Map();
  const query = CompensationEntryModel.find({ employeeId: { $in: objectIds(employeeIds) } });
  if (withAmounts) query.select('+basicSalaryCentavos');
  const rows = await query.lean<
    {
      _id: Types.ObjectId;
      employeeId: Types.ObjectId;
      effectiveDate: Date;
      createdAt: Date;
      rateType: PayrollSalaryEntry['rateType'];
      minimumWageEarner: boolean;
      basicSalaryCentavos?: unknown;
    }[]
  >();
  const entries = await Promise.all(
    rows.map(async (row) => ({
      employeeId: row.employeeId.toHexString(),
      entry: {
        id: row._id.toHexString(),
        effectiveDate: dayOf(row.effectiveDate),
        createdAt: row.createdAt,
        rateType: row.rateType,
        amountCentavos: withAmounts ? ((await decryptCentavos(row.basicSalaryCentavos)) ?? 0) : 0,
        minimumWageEarner: row.minimumWageEarner,
      } satisfies PayrollSalaryEntry,
    })),
  );
  const result = new Map<string, PayrollSalaryEntry[]>();
  for (const { employeeId, entry } of entries) {
    const list = result.get(employeeId) ?? [];
    list.push(entry);
    result.set(employeeId, list);
  }
  return result;
}

async function loadAllowanceEntries(
  employeeIds: readonly string[],
): Promise<Map<string, PayrollAllowanceEntry[]>> {
  if (employeeIds.length === 0) return new Map();
  const rows = await AllowanceAssignmentModel.find({ employeeId: { $in: objectIds(employeeIds) } })
    .select('+amountCentavos')
    .lean<
      {
        _id: Types.ObjectId;
        employeeId: Types.ObjectId;
        typeKey: string;
        effectiveDate: Date;
        kind: PayrollAllowanceEntry['kind'];
        createdAt: Date;
        amountCentavos?: unknown;
      }[]
    >();
  const result = new Map<string, PayrollAllowanceEntry[]>();
  for (const row of rows) {
    const key = row.employeeId.toHexString();
    const list = result.get(key) ?? [];
    list.push({
      id: row._id.toHexString(),
      typeKey: row.typeKey,
      effectiveDate: dayOf(row.effectiveDate),
      kind: row.kind,
      createdAt: row.createdAt,
      amountCentavos: row.kind === 'set' ? await decryptCentavos(row.amountCentavos) : null,
    });
    result.set(key, list);
  }
  return result;
}

/** A finalized or mid-month run's line, decrypted. */
interface StoredLine {
  runId: string;
  employeeId: string;
  breakdown: PayrollBreakdown;
}

async function loadLines(runIds: readonly Types.ObjectId[], employeeIds: readonly string[]) {
  if (runIds.length === 0 || employeeIds.length === 0) return [] as StoredLine[];
  const rows = await PayrollRunEmployeeModel.find({
    runId: { $in: runIds },
    employeeId: { $in: objectIds(employeeIds) },
  })
    .select('+breakdown')
    .lean<{ runId: Types.ObjectId; employeeId: Types.ObjectId; breakdown: unknown }[]>();
  return Promise.all(
    rows.map(async (row) => ({
      runId: row.runId.toHexString(),
      employeeId: row.employeeId.toHexString(),
      breakdown: parsePayrollBreakdown(String(await decryptSensitive(row.breakdown))),
    })),
  );
}

// ---------------------------------------------------------------------------------------------
// Manual entries (step 2.10, decisions 355–358)

/** A stored manual entry, its amount decrypted when asked for (`payrollManualEntries`). */
export interface StoredPayrollManualEntry {
  id: string;
  runId: string;
  employeeId: string;
  kind: PayrollManualEntryKind;
  targetLineKey: string | null;
  label: string;
  /** Whole centavos when loaded with amounts; null without them, and on a removal with none. */
  amountCentavos: Centavos | null;
  taxable: boolean | null;
  reducesTaxablePay: boolean | null;
  authorizedInWriting: boolean | null;
  countsAsBasicSalary: boolean | null;
  reason: string;
  supersedesId: string | null;
  removed: boolean;
  createdAt: Date;
  /** The user who entered it. */
  createdBy: string | null;
}

/** A stored entry document as the services read it. */
export async function storedManualEntryOf(
  row: Omit<PayrollManualEntryDocument, 'amountCentavos'> & { amountCentavos?: unknown },
  withAmount: boolean,
): Promise<StoredPayrollManualEntry> {
  return {
    id: row._id.toHexString(),
    runId: row.runId.toHexString(),
    employeeId: row.employeeId.toHexString(),
    kind: row.kind,
    targetLineKey: row.targetLineKey ?? null,
    label: row.label,
    amountCentavos: withAmount ? await decryptCentavos(row.amountCentavos) : null,
    taxable: row.taxable ?? null,
    reducesTaxablePay: row.reducesTaxablePay ?? null,
    authorizedInWriting: row.authorizedInWriting ?? null,
    countsAsBasicSalary: row.countsAsBasicSalary ?? null,
    reason: row.reason,
    supersedesId: row.supersedesId ? row.supersedesId.toHexString() : null,
    removed: row.removed === true,
    createdAt: row.createdAt,
    createdBy: row.createdBy ? row.createdBy.toHexString() : null,
  };
}

/**
 * Every manual entry of a run (each chain whole, oldest first), optionally one employee's only.
 * The amounts are decrypted only with `withAmounts`: a caller that sends them has written its
 * `reveal` first, or applies them in a compute.
 */
export async function loadPayrollManualEntries(
  runId: Types.ObjectId,
  {
    withAmounts = false,
    employeeId = null,
    session = null,
  }: { withAmounts?: boolean; employeeId?: string | null; session?: ClientSession | null } = {},
): Promise<StoredPayrollManualEntry[]> {
  const filter: Record<string, unknown> = { runId };
  if (employeeId) filter.employeeId = new Types.ObjectId(employeeId);
  const query = PayrollManualEntryModel.find(filter)
    .sort({ createdAt: 1, _id: 1 })
    .session(session);
  if (withAmounts) query.select(PAYROLL_MANUAL_ENTRY_AMOUNT_SELECT);
  const rows =
    await query.lean<
      (Omit<PayrollManualEntryDocument, 'amountCentavos'> & { amountCentavos?: unknown })[]
    >();
  return Promise.all(rows.map((row) => storedManualEntryOf(row, withAmounts)));
}

/** A live entry as the engine reads it (its amount must have been loaded). */
function engineEntryOf(entry: StoredPayrollManualEntry): PayrollManualEntryInput {
  return {
    id: entry.id,
    kind: entry.kind,
    targetLineKey: entry.targetLineKey,
    label: entry.label,
    amountCentavos: entry.amountCentavos ?? 0,
    taxable: entry.taxable,
    reducesTaxablePay: entry.reducesTaxablePay,
    authorizedInWriting: entry.authorizedInWriting,
    countsAsBasicSalary: entry.countsAsBasicSalary,
  };
}

/** The run's window: every cut-off whose days it reads, oldest first. */
interface RunWindow {
  cutOff: CutOffPeriod;
  /** The earlier cut-offs reconciled, oldest first. */
  earlier: CutOffPeriod[];
  /** Every period computed (the earlier ones, then the run's), each with its previous cut-off. */
  from: BusinessDate;
  to: BusinessDate;
}

function windowOf(
  cutOff: CutOffPeriod,
  first: CutOffPeriod,
  versions: PayrollRunVersions,
): RunWindow {
  const policy = runSettingsOn(versions, cutOff.start).value;
  const earlier = settlementCutOffs(
    cutOff,
    policy.adjustmentLookbackCutOffs,
    first.start,
    versions.payroll,
  ).reverse();
  const oldest = earlier[0] ?? cutOff;
  // The cut-off before the oldest, for the workday-before rule of a holiday early in it.
  const from = previousCutOff(oldest, versions.payroll).start;
  return { cutOff, earlier, from, to: cutOff.end };
}

/** The window's days (oldest computed cut-off's previous one to the run's end). */
export function payrollRunWindow(
  cutOff: CutOffPeriod,
  first: CutOffPeriod,
  versions: PayrollRunVersions,
): { from: BusinessDate; to: BusinessDate } {
  const { from, to } = windowOf(cutOff, first, versions);
  return { from, to };
}

// ---------------------------------------------------------------------------------------------
// The computation

/** One computed employee line, ready to encrypt and store. */
export interface ComputedPayrollLine {
  employeeId: string;
  timesheetId: string | null;
  timesheetStatus: TimesheetDocument['status'] | null;
  timesheetApproved: boolean;
  /** The run's own period start and each settled one. */
  settledPeriods: BusinessDate[];
  breakdown: PayrollBreakdown;
  /** Step 2.10: the review flags (decision 352), plain. */
  flags: PayrollLineFlag[];
  /** Step 2.10: the live manual entries given to the line (applied or stale). */
  manualEntryCount: number;
}

export interface ComputedPayrollRun {
  cutOff: CutOffPeriod;
  contributionMonth: string;
  lines: ComputedPayrollLine[];
  leftOut: { employeeId: string; reason: PayrollLeftOutReason }[];
  totals: PayrollTotals;
  settingVersions: PayrollRunSettingVersion[];
  /**
   * Step 2.10: per flag kind, the lines carrying it; `manualEntryStale` also counts each employee
   * with a live entry but no line (`employeeNotInRun`).
   */
  flagCounts: PayrollFlagCounts;
  /** Step 2.10: live manual entries whose employee has no line in the run (`employeeNotInRun`). */
  orphanEntries: { entryId: string; employeeId: string }[];
}

const ZERO_TOTALS: PayrollTotals = {
  grossCentavos: 0,
  deductionsCentavos: 0,
  netPayCentavos: 0,
  reimbursementsCentavos: 0,
  taxWithheldCentavos: 0,
  employeeContributionsCentavos: 0,
  employerContributionsCentavos: 0,
};

function addTotals(a: PayrollTotals, b: PayrollTotals): PayrollTotals {
  return {
    grossCentavos: a.grossCentavos + b.grossCentavos,
    deductionsCentavos: a.deductionsCentavos + b.deductionsCentavos,
    netPayCentavos: a.netPayCentavos + b.netPayCentavos,
    reimbursementsCentavos: a.reimbursementsCentavos + b.reimbursementsCentavos,
    taxWithheldCentavos: a.taxWithheldCentavos + b.taxWithheldCentavos,
    employeeContributionsCentavos:
      a.employeeContributionsCentavos + b.employeeContributionsCentavos,
    employerContributionsCentavos:
      a.employerContributionsCentavos + b.employerContributionsCentavos,
  };
}

/** The de minimis limit period of `day` (`month`, `semester` or `year`), as a comparable key. */
function limitPeriodKey(period: 'month' | 'semester' | 'year', day: BusinessDate): string {
  const year = day.slice(0, 4);
  if (period === 'year') return year;
  if (period === 'month') return day.slice(0, 7);
  return `${year}-H${Number(day.slice(5, 7)) <= 6 ? 1 : 2}`;
}

function settingVersionsOf(
  cutOff: CutOffPeriod,
  versions: PayrollRunVersions,
): PayrollRunSettingVersion[] {
  const month = firstOfMonth(cutOff.payDate);
  const one = (key: string, found: EffectiveVersion<unknown> | null) => ({
    key,
    effectiveFrom: found?.effectiveFrom ?? null,
  });
  const during = (key: string, list: readonly EffectiveVersion<unknown>[]) => {
    const found = versionsDuring(list, cutOff.start, cutOff.end);
    return found.length > 0
      ? found.map((v) => ({ key, effectiveFrom: v.effectiveFrom }))
      : [{ key, effectiveFrom: null }];
  };
  return [
    one(PAYROLL_SETTINGS_SETTING.key, versionOn(versions.payroll, cutOff.start)),
    {
      key: PAYROLL_RUN_SETTINGS_SETTING.key,
      effectiveFrom: runSettingsOn(versions, cutOff.start).effectiveFrom,
    },
    one(SSS_CONTRIBUTIONS_SETTING.key, versionOn(versions.sss, month)),
    one(PHILHEALTH_CONTRIBUTIONS_SETTING.key, versionOn(versions.philhealth, month)),
    one(PAGIBIG_CONTRIBUTIONS_SETTING.key, versionOn(versions.pagibig, month)),
    one(WITHHOLDING_TAX_SEMI_MONTHLY_SETTING.key, versionOn(versions.withholding, cutOff.payDate)),
    one(DE_MINIMIS_LIMITS_SETTING.key, versionOn(versions.deMinimisLimits, cutOff.payDate)),
    one(MINIMUM_WAGES_SETTING.key, versionOn(versions.minimumWages, cutOff.payDate)),
    ...during(PREMIUM_RATES_SETTING.key, versions.premiumRates),
    ...during(ALLOWANCE_TYPES_SETTING.key, versions.allowanceTypes),
    ...during(WORK_SCHEDULE_SETTING.key, versions.workSchedule),
    ...during(TIMESHEET_SETTINGS_SETTING.key, versions.timesheetSettings),
  ];
}

export interface ComputeRunOptions {
  /** Today's Manila day (the DTR lists every day of an ended cut-off). */
  today: BusinessDate;
  versions?: PayrollRunVersions;
  /** Step 2.10: the stored run whose live manual entries apply; none for a new draft. */
  runId?: Types.ObjectId | null;
  /**
   * Step 2.10: entries not stored yet, applied as if they were (a manual entry save computes the
   * run with its own new entry, then stores both in one transaction). Each needs its amount,
   * except a removal.
   */
  pendingEntries?: readonly StoredPayrollManualEntry[];
}

/** The live entries of a run (stored and pending), by employee. */
async function liveEntriesByEmployee(
  runId: Types.ObjectId | null | undefined,
  pending: readonly StoredPayrollManualEntry[],
): Promise<Map<string, StoredPayrollManualEntry[]>> {
  const stored = runId ? await loadPayrollManualEntries(runId, { withAmounts: true }) : [];
  const live = livePayrollManualEntries([...stored, ...pending]);
  const result = new Map<string, StoredPayrollManualEntry[]>();
  for (const entry of live) {
    const list = result.get(entry.employeeId);
    if (list) list.push(entry);
    else result.set(entry.employeeId, [entry]);
  }
  return result;
}

/** The daily minimum wage in effect on each day of `calendar` for `region` (or null). */
function minimumWageByDay(
  calendar: readonly Pick<PayrollCalendarDay, 'date'>[],
  versions: PayrollRunVersions,
  region: WorkRegion,
): Record<BusinessDate, Centavos | null> {
  const result: Record<BusinessDate, Centavos | null> = {};
  for (const { date } of calendar) {
    const wages = versionOn(versions.minimumWages, date)?.value ?? null;
    result[date] = minimumWageForRegion(wages, region)?.dailyRateCentavos ?? null;
  }
  return result;
}

/**
 * Computes the lines of the regular run for `cutOff` from their sources as they are now: who is
 * in it, each employee's own pay, the settlements of the earlier cut-offs within the lookback
 * against finalized runs, the mid-month pairing and the totals. Writes nothing.
 */
export async function computePayrollRun(
  cutOff: CutOffPeriod,
  first: CutOffPeriod,
  { today, versions: given, runId = null, pendingEntries = [] }: ComputeRunOptions,
): Promise<ComputedPayrollRun> {
  await connectDb();
  const versions = given ?? (await loadPayrollRunVersions());
  const window = windowOf(cutOff, first, versions);
  const contributionMonth = contributionMonthOf(cutOff.payDate);

  // Settings checked up front, so a missing seed refuses before anything is read.
  const month = firstOfMonth(cutOff.payDate);
  const sss = required(versions.sss, month).value;
  const philhealth = required(versions.philhealth, month).value;
  const pagibig = required(versions.pagibig, month).value;
  const withholding = required(versions.withholding, cutOff.payDate).value;
  const deMinimisLimits = required(versions.deMinimisLimits, cutOff.payDate).value;
  const minimumWages = versionOn(versions.minimumWages, cutOff.payDate)?.value ?? null;

  // Who is in the run (decision 327): employment overlaps the cut-off; no salary → left out.
  const identities = (await listEmployeeIdentities(PAYROLL_READER, { separated: true })).filter(
    (identity) =>
      identity.dateHired <= cutOff.end &&
      (identity.separationDate === null || identity.separationDate >= cutOff.start),
  );
  const salaries = await loadSalaries(identities.map((identity) => identity.employeeId));
  const leftOut: ComputedPayrollRun['leftOut'] = [];
  const members: EmployeeIdentity[] = [];
  for (const identity of identities) {
    const membership = payrollRunMembership(
      {
        dateHired: identity.dateHired,
        separationDate: identity.separationDate,
        salaries: salaries.get(identity.employeeId) ?? [],
      },
      { start: cutOff.start, end: cutOff.end },
    );
    if (membership.included) members.push(identity);
    else if (membership.reason === 'noSalary') {
      leftOut.push({ employeeId: identity.employeeId, reason: 'noSalary' });
    }
  }
  const result: ComputedPayrollRun = {
    cutOff,
    contributionMonth,
    lines: [],
    leftOut,
    totals: { ...ZERO_TOTALS },
    settingVersions: settingVersionsOf(cutOff, versions),
    flagCounts: countPayrollFlags([]),
    orphanEntries: [],
  };
  // The live manual entries (decision 358); an employee with entries but no line makes them stale.
  const manualEntries = await liveEntriesByEmployee(runId, pendingEntries);
  const memberSet = new Set(members.map((identity) => identity.employeeId));
  for (const [employeeId, entries] of manualEntries) {
    if (memberSet.has(employeeId)) continue;
    for (const entry of entries) result.orphanEntries.push({ entryId: entry.id, employeeId });
  }
  const orphanEmployees = new Set(result.orphanEntries.map((entry) => entry.employeeId)).size;
  result.flagCounts.manualEntryStale = orphanEmployees;
  if (members.length === 0) return result;
  const memberIds = members.map((identity) => identity.employeeId);

  // Every source once for the whole window.
  const periodStarts = [...window.earlier, cutOff].flatMap((period) => [
    period.start,
    previousCutOff(period, versions.payroll).start,
  ]);
  const [
    holidays,
    allowanceEntries,
    regions,
    timesheetRows,
    entryRows,
    finalizedRuns,
    midMonthRun,
    onboarding,
  ] = await Promise.all([
    listConfirmedHolidays({ from: window.from, to: window.to }),
    loadAllowanceEntries(memberIds),
    workRegionsOf(memberIds),
    TimesheetModel.find({
      employeeId: { $in: objectIds(memberIds) },
      periodStart: { $in: [...new Set(periodStarts)].map(instantOf) },
    }).lean<TimesheetDocument[]>(),
    TimeEntryModel.find({
      employeeId: { $in: objectIds(memberIds) },
      date: { $gte: instantOf(window.from), $lte: instantOf(window.to) },
    })
      .sort({ timeIn: 1, _id: 1 })
      .lean<TimeEntryDocument[]>(),
    // Finalized regular runs that may have paid a period of the window, or count against a de
    // minimis limit in the pay date's year.
    PayrollRunModel.find({
      kind: 'regular',
      status: 'finalized',
      $or: [
        { periodStart: { $gte: instantOf(window.from) } },
        { payDate: { $gte: instantOf(`${cutOff.payDate.slice(0, 4)}-01-01`) } },
      ],
    })
      .select({ _id: 1, payDate: 1, periodStart: 1 })
      .lean<Pick<PayrollRunDocument, '_id' | 'payDate' | 'periodStart'>[]>(),
    cutOff.key === 'endOfMonth'
      ? PayrollRunModel.findOne({
          kind: 'regular',
          cutOffKey: 'midMonth',
          contributionMonth,
        })
          .select({ _id: 1 })
          .lean<Pick<PayrollRunDocument, '_id'>>()
      : Promise.resolve(null),
    // The `includeInPayroll` gate on the day of the compute (decision 352): presence facts only.
    deriveOnboarding(memberIds, today),
  ]);

  const approvedIds = timesheetRows
    .filter((row) => row.status === 'approved')
    .map((row) => row._id);
  const [reimbursementRows, finalizedLines, midMonthLines] = await Promise.all([
    approvedIds.length
      ? ReimbursementModel.find({ timesheetId: { $in: approvedIds } })
          .select({ timesheetId: 1, amountCentavos: 1 })
          .lean<{ timesheetId: Types.ObjectId; amountCentavos: number }[]>()
      : Promise.resolve([]),
    loadLines(
      finalizedRuns.map((run) => run._id),
      memberIds,
    ),
    midMonthRun ? loadLines([midMonthRun._id], memberIds) : Promise.resolve([] as StoredLine[]),
  ]);
  const payDateOfRun = new Map(
    finalizedRuns.map((run) => [run._id.toHexString(), dayOf(run.payDate)]),
  );
  const reimbursements = new Map<string, { receipts: number; totalCentavos: Centavos }>();
  for (const row of reimbursementRows) {
    const key = row.timesheetId.toHexString();
    const found = reimbursements.get(key) ?? { receipts: 0, totalCentavos: 0 };
    found.receipts += 1;
    found.totalCentavos += row.amountCentavos;
    reimbursements.set(key, found);
  }
  const timesheetsByEmployee = groupBy(timesheetRows, (row) => row.employeeId.toHexString());
  const entriesByEmployee = groupBy(entryRows, (row) => row.employeeId.toHexString());
  const finalizedByEmployee = groupBy(finalizedLines, (line) => line.employeeId);
  const midMonthByEmployee = new Map(midMonthLines.map((line) => [line.employeeId, line]));

  for (const identity of members) {
    const employeeId = identity.employeeId;
    const subject = { dateHired: identity.dateHired, separationDate: identity.separationDate };
    const [assignments, timeOff] = await Promise.all([
      loadWorkScheduleAssignments(employeeId),
      approvedTimeOffInputs(employeeId, subject, { from: window.from, to: window.to }),
    ]);
    const midMonthLine = midMonthByEmployee.get(employeeId);
    const sources: EmployeeSources = {
      identity,
      salaries: salaries.get(employeeId) ?? [],
      allowanceEntries: allowanceEntries.get(employeeId) ?? [],
      assignments,
      entries: entriesByEmployee.get(employeeId) ?? [],
      timeOff,
      timesheets: new Map(
        (timesheetsByEmployee.get(employeeId) ?? []).map((row) => [dayOf(row.periodStart), row]),
      ),
      region: regions.get(employeeId) ?? DEFAULT_WORK_REGION,
      finalized: (finalizedByEmployee.get(employeeId) ?? []).map((line) => ({
        payDate: payDateOfRun.get(line.runId) ?? line.breakdown.cutOff.payDate,
        breakdown: line.breakdown,
      })),
      midMonth: midMonthLine ? midMonthFiguresOf(midMonthLine.breakdown) : null,
      manualEntries: (manualEntries.get(employeeId) ?? []).map(engineEntryOf),
      onboarding: onboarding.get(employeeId)?.status ?? { states: {} },
    };
    const line = computeEmployeeLine(sources, {
      window,
      versions,
      holidays,
      reimbursements,
      today,
      tables: { sss, philhealth, pagibig, withholding, deMinimisLimits, minimumWages },
    });
    result.lines.push(line);
    result.totals = addTotals(result.totals, line.breakdown.totals);
  }
  const lineCounts = countPayrollFlags(result.lines);
  result.flagCounts = {
    ...lineCounts,
    manualEntryStale: lineCounts.manualEntryStale + orphanEmployees,
  };
  return result;
}

interface LineContext {
  window: RunWindow;
  versions: PayrollRunVersions;
  holidays: DtrSources['holidays'];
  reimbursements: Map<string, { receipts: number; totalCentavos: Centavos }>;
  today: BusinessDate;
  tables: {
    sss: SssContributions;
    philhealth: PhilhealthContributions;
    pagibig: PagibigContributions;
    withholding: WithholdingTaxSemiMonthly;
    deMinimisLimits: DeMinimisLimits;
    minimumWages: MinimumWages | null;
  };
}

/** One employee's line for the run: their own period, the earlier ones, and the engine. */
function computeEmployeeLine(sources: EmployeeSources, context: LineContext): ComputedPayrollLine {
  const { window, versions, holidays, today } = context;
  const { identity } = sources;
  const subject = { dateHired: identity.dateHired, separationDate: identity.separationDate };
  const employee = {
    dateHired: identity.dateHired,
    separationDate: identity.separationDate,
    salaries: sources.salaries,
    allowanceEntries: sources.allowanceEntries,
  };
  const dtrSources: DtrSources = {
    holidays,
    workSchedules: versions.workSchedule,
    assignments: sources.assignments,
    premiumRates: versions.premiumRates as ConfigVersion<NightWindow>[],
    timesheetSettings: versions.timesheetSettings,
    payrollVersions: versions.payroll,
  };
  const calendar = (from: BusinessDate, to: BusinessDate): PayrollCalendarDay[] =>
    payrollCalendar({
      from,
      to,
      workSchedules: versions.workSchedule,
      assignments: sources.assignments,
      holidays,
    });

  // Each period's approved DTR days, computed once (null when its timesheet isn't approved).
  const dtrDays = new Map<BusinessDate, PayrollTimesheetInput['days'] | null>();
  const approvedDaysOf = (period: CutOffPeriod) => {
    if (dtrDays.has(period.start)) return dtrDays.get(period.start) ?? null;
    const timesheet = sources.timesheets.get(period.start);
    let days: PayrollTimesheetInput['days'] | null = null;
    if (timesheet && timesheet.status === 'approved') {
      days = dtrOf({
        subject,
        period: { start: period.start, end: period.end },
        timesheetType: timesheet.timesheetType,
        approved: true,
        sources: dtrSources,
        entries: sources.entries.filter((entry) => {
          const day = dayOf(entry.date);
          return day >= period.start && day <= period.end;
        }),
        today,
        timeOff: sources.timeOff.filter(
          (day) => day.date >= period.start && day.date <= period.end,
        ),
      }).days;
    }
    dtrDays.set(period.start, days);
    return days;
  };

  const periodInput = (period: CutOffPeriod): PayrollPeriodInput => {
    const previous = previousCutOff(period, versions.payroll);
    const previousApproved = approvedDaysOf(previous);
    const previousStatus = new Map((previousApproved ?? []).map((day) => [day.date, day.status]));
    const previousDays: PayrollPriorDay[] = calendar(previous.start, addDays(period.start, -1)).map(
      (day) => ({
        ...day,
        status: previousApproved ? (previousStatus.get(day.date) ?? null) : null,
        approved: previousApproved !== null,
      }),
    );
    const stored = sources.timesheets.get(period.start) ?? null;
    const days = approvedDaysOf(period);
    const timesheet: PayrollTimesheetInput | null = stored
      ? {
          type: stored.timesheetType,
          status: stored.status,
          days: days ?? [],
          reimbursements: (stored.status === 'approved'
            ? context.reimbursements.get(stored._id.toHexString())
            : null) ?? { receipts: 0, totalCentavos: 0 },
        }
      : null;
    return {
      periodStart: period.start,
      periodEnd: period.end,
      employee,
      calendar: calendar(period.start, period.end),
      previousDays,
      timesheet,
      payrollSettings: required(versions.payroll, period.start).value,
      policy: runSettingsOn(versions, period.start).value,
      premiumRates: versions.premiumRates,
      allowanceTypes: versions.allowanceTypes,
    };
  };

  // The earlier cut-offs: the items now, against what finalized runs paid (decision 339).
  const earlierPeriods: PayrollEarlierPeriodInput[] = [];
  for (const period of window.earlier) {
    const membership = payrollRunMembership(employee, { start: period.start, end: period.end });
    const now: PayrollAttendanceItem[] = membership.included
      ? computePeriodPay(periodInput(period)).attendanceItems
      : [];
    const paid = sumAttendanceItems(
      sources.finalized.map((line) => attendanceItemsPaidFor(line.breakdown, period.start)),
    );
    if (now.length === 0 && paid.length === 0) continue;
    earlierPeriods.push({ periodStart: period.start, periodEnd: period.end, now, paid });
  }

  // What finalized runs counted against each de minimis limit in its period of the pay date.
  const { cutOff } = window;
  const deMinimisPaidCentavos: Record<string, Centavos> = {};
  for (const line of sources.finalized) {
    for (const item of line.breakdown.deMinimis) {
      if (item.period === 'day') continue;
      if (limitPeriodKey(item.period, line.payDate) !== limitPeriodKey(item.period, cutOff.payDate))
        continue;
      deMinimisPaidCentavos[item.key] =
        (deMinimisPaidCentavos[item.key] ?? 0) + item.amountCentavos;
    }
  }

  const own = periodInput(cutOff);
  const { tables } = context;
  const breakdown = computePayrollLine({
    employee: own.employee,
    calendar: own.calendar,
    previousDays: own.previousDays,
    timesheet: own.timesheet,
    payrollSettings: own.payrollSettings,
    policy: own.policy,
    premiumRates: own.premiumRates,
    allowanceTypes: own.allowanceTypes,
    cutOff,
    sss: tables.sss,
    philhealth: tables.philhealth,
    pagibig: tables.pagibig,
    withholding: tables.withholding,
    deMinimisLimits: tables.deMinimisLimits,
    minimumWageDailyCentavos:
      minimumWageForRegion(tables.minimumWages, sources.region)?.dailyRateCentavos ?? null,
    deMinimisPaidCentavos,
    midMonth: cutOff.key === 'endOfMonth' ? sources.midMonth : null,
    earlierPeriods,
    manualEntries: sources.manualEntries,
  });
  const stored = sources.timesheets.get(cutOff.start) ?? null;
  // The review flags (decision 352): the minimum wage by day for the employee's current region
  // (HANDOFF item 285), with the cut-off's daily rate factor.
  const flags = derivePayrollLineFlags({
    breakdown,
    onboarding: sources.onboarding,
    daysBelowMinimumWage: daysBelowMinimumWage({
      employee: own.employee,
      calendar: own.calendar,
      dailyRateFactor: own.payrollSettings.dailyRateFactor,
      minimumWageByDay: minimumWageByDay(own.calendar, versions, sources.region),
    }),
  });
  return {
    employeeId: identity.employeeId,
    timesheetId: stored ? stored._id.toHexString() : null,
    timesheetStatus: stored?.status ?? null,
    timesheetApproved: stored?.status === 'approved',
    settledPeriods: [cutOff.start, ...breakdown.settledPeriods],
    breakdown,
    flags,
    manualEntryCount: sources.manualEntries.length,
  };
}

// ---------------------------------------------------------------------------------------------
// The job's creation rule

/**
 * The employees a run for `cutOff` would include (membership only, no amount decrypted), with
 * their timesheet status for it: the job creates the draft once each is approved (decision 342).
 */
export async function payrollRunMembers(
  cutOff: CutOffPeriod,
): Promise<{ employeeId: string; timesheetApproved: boolean }[]> {
  await connectDb();
  const identities = (await listEmployeeIdentities(PAYROLL_READER, { separated: true })).filter(
    (identity) =>
      identity.dateHired <= cutOff.end &&
      (identity.separationDate === null || identity.separationDate >= cutOff.start),
  );
  const salaries = await loadSalaries(
    identities.map((identity) => identity.employeeId),
    { withAmounts: false },
  );
  const members = identities.filter(
    (identity) =>
      payrollRunMembership(
        {
          dateHired: identity.dateHired,
          separationDate: identity.separationDate,
          salaries: salaries.get(identity.employeeId) ?? [],
        },
        { start: cutOff.start, end: cutOff.end },
      ).included,
  );
  if (members.length === 0) return [];
  const approved = new Set(
    (
      await TimesheetModel.find(
        {
          employeeId: { $in: objectIds(members.map((m) => m.employeeId)) },
          periodStart: instantOf(cutOff.start),
          status: 'approved',
        },
        { employeeId: 1 },
      ).lean<{ employeeId: Types.ObjectId }[]>()
    ).map((row) => row.employeeId.toHexString()),
  );
  return members.map((identity) => ({
    employeeId: identity.employeeId,
    timesheetApproved: approved.has(identity.employeeId),
  }));
}
