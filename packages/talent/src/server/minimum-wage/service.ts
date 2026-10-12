import { type ClientSession, Types } from 'mongoose';
import { connectDb } from '@pulse/db';
import {
  ActionError,
  type BusinessDate,
  businessToday,
  type Centavos,
  toBusinessDate,
} from '@pulse/core';
import { decryptSensitive, listConfigVersions, listEmployeeIdentities } from '@pulse/core/server';
import { compensationStatuses } from '../../compensation';
import { DEFAULT_WORK_REGION, type RateType, type WorkRegion } from '../../fixed-sets';
import { isBelowMinimumWage } from '../../payroll/lookups';
import {
  type MinimumWageWarning,
  minimumWageForRegion,
  minimumWageWarningFor,
  noMinimumWageNote,
} from '../../payroll/minimum-wage';
import type { MinimumWages } from '../../payroll/schemas';
import type {
  BelowMinimumWageList,
  BelowMinimumWageRow,
  MinimumWageBelowCount,
} from '../../payroll/views';
import { CompensationEntryModel } from '../compensation/model';
import { EmployeeRecordModel } from '../employee-records/model';
import { assertCanViewWageOrderList, type TalentActor } from '../policy';
import { MINIMUM_WAGES_SETTING, payrollSettingVersionOn } from '../payroll-settings/settings';

// Spec: docs/modules/talent.md#payroll-settings-and-allowances-build-step-23 ("Minimum wage
// warning", decisions 205–207 in docs/BUILD_PLAN.md).
//
// - The check uses the work region (NCR when the record has none) and the `talent.minimumWages`
//   and `talent.payrollSettings` versions in effect on the later of the entry's effective date and
//   today. The comparison is exact (isBelowMinimumWage).
// - The badge: the current salary below the minimum in effect today.
// - The wage order list: active employees in the version's region paid below it, on the later of
//   its effective date and today. Names, numbers, departments and positions only, never an amount;
//   Talent Read and HR, Accounting or the System Administrator; not audit-logged. Salaries are
//   decrypted here, on the server, only to compare; none leaves this module.

const NO_PAY_SCHEDULE =
  'No pay schedule is on file for that date, so a monthly salary can’t be compared with the minimum wage. Add one in Payroll settings.';

const later = (a: BusinessDate, b: BusinessDate) => (a > b ? a : b);

/** The work region of each employee: their record's, or NCR. */
export async function workRegionsOf(
  employeeIds: readonly string[],
  { session }: { session?: ClientSession } = {},
): Promise<Map<string, WorkRegion>> {
  const regions = new Map<string, WorkRegion>(employeeIds.map((id) => [id, DEFAULT_WORK_REGION]));
  if (employeeIds.length === 0) return regions;
  await connectDb();
  const records = await EmployeeRecordModel.find(
    { employeeId: { $in: employeeIds.map((id) => new Types.ObjectId(id)) } },
    { employeeId: 1, workRegion: 1 },
  )
    .session(session ?? null)
    .lean();
  for (const record of records) {
    regions.set(record.employeeId.toHexString(), record.workRegion ?? DEFAULT_WORK_REGION);
  }
  return regions;
}

export type MinimumWageCheck =
  | { status: 'ok'; checkedOn: BusinessDate }
  | { status: 'below'; warning: MinimumWageWarning }
  | { status: 'noRate'; note: string; checkedOn: BusinessDate };

/** Compares one salary with its region's minimum wage, on the later of `effectiveDate` and `today`. */
export async function checkMinimumWage({
  amountCentavos,
  rateType,
  region,
  effectiveDate,
  today = businessToday(),
  session,
}: {
  amountCentavos: Centavos;
  rateType: RateType;
  region: WorkRegion;
  effectiveDate: BusinessDate;
  today?: BusinessDate;
  session?: ClientSession;
}): Promise<MinimumWageCheck> {
  const checkedOn = later(effectiveDate, today);
  const wages = await payrollSettingVersionOn('talent.minimumWages', checkedOn, { session });
  const row = minimumWageForRegion(wages?.value, region);
  if (!row) return { status: 'noRate', note: noMinimumWageNote(region), checkedOn };
  const factor = await dailyRateFactorOn(checkedOn, rateType, session);
  const warning = minimumWageWarningFor({
    amountCentavos,
    rateType,
    region,
    wageOrder: row.wageOrder,
    minimumDailyRateCentavos: row.dailyRateCentavos,
    dailyRateFactor: factor,
    checkedOn,
  });
  return warning ? { status: 'below', warning } : { status: 'ok', checkedOn };
}

/** The daily rate factor on `day`; a daily-rated salary doesn't need one (1 is never used). */
async function dailyRateFactorOn(
  day: BusinessDate,
  rateType: RateType,
  session?: ClientSession,
): Promise<number> {
  const settings = await payrollSettingVersionOn('talent.payrollSettings', day, { session });
  if (settings) return settings.value.dailyRateFactor;
  if (rateType === 'daily') return 1;
  throw new ActionError(NO_PAY_SCHEDULE);
}

interface SalaryOnDay {
  amountCentavos: Centavos;
  rateType: RateType;
}

/** Each employee's current salary on `day` (decrypted, server-only), by employee id. */
async function salariesOn(
  employeeIds: readonly string[],
  day: BusinessDate,
): Promise<Map<string, SalaryOnDay>> {
  const salaries = new Map<string, SalaryOnDay>();
  if (employeeIds.length === 0) return salaries;
  await connectDb();
  const rows = await CompensationEntryModel.find({
    employeeId: { $in: employeeIds.map((id) => new Types.ObjectId(id)) },
  })
    .select('+basicSalaryCentavos')
    .lean();
  const byEmployee = new Map<string, typeof rows>();
  for (const row of rows) {
    const key = row.employeeId.toHexString();
    byEmployee.set(key, [...(byEmployee.get(key) ?? []), row]);
  }
  for (const [employeeId, entries] of byEmployee) {
    const timeline = entries.map((row) => ({
      row,
      id: row._id.toHexString(),
      effectiveDate: toBusinessDate(row.effectiveDate),
      createdAt: row.createdAt,
    }));
    const statuses = compensationStatuses(timeline, day);
    const current = timeline.find((entry) => statuses.get(entry.id) === 'current');
    if (!current) continue;
    const amount = await decryptSensitive(current.row.basicSalaryCentavos);
    if (typeof amount !== 'number') continue;
    salaries.set(employeeId, { amountCentavos: amount, rateType: current.row.rateType });
  }
  return salaries;
}

/** True when `employeeId`'s current salary is below the minimum in effect `today` (the badge). */
export async function isCurrentSalaryBelowMinimumWage(
  employeeId: string,
  region: WorkRegion,
  today: BusinessDate,
): Promise<boolean> {
  const wages = await payrollSettingVersionOn('talent.minimumWages', today);
  const row = minimumWageForRegion(wages?.value, region);
  if (!row) return false;
  const salary = (await salariesOn([employeeId], today)).get(employeeId);
  if (!salary) return false;
  const settings = await payrollSettingVersionOn('talent.payrollSettings', today);
  if (!settings && salary.rateType === 'monthly') return false;
  return isBelowMinimumWage(
    salary.amountCentavos,
    salary.rateType,
    row.dailyRateCentavos,
    settings?.value.dailyRateFactor ?? 1,
  );
}

interface BelowResult {
  checkedOn: BusinessDate;
  wageOrder: string;
  employeeIds: Set<string>;
}

/** The active employees in `region` paid below `wages`' rate, on the later of `effectiveFrom` and today. */
async function employeesBelow(
  actor: TalentActor,
  wages: MinimumWages,
  effectiveFrom: BusinessDate,
  region: WorkRegion,
): Promise<BelowResult & { identities: Awaited<ReturnType<typeof listEmployeeIdentities>> }> {
  const checkedOn = later(effectiveFrom, businessToday());
  const row = minimumWageForRegion(wages, region);
  // Active (not separated) employees only: the identity service leaves separated ones out.
  const identities = await listEmployeeIdentities(actor);
  if (!row) return { checkedOn, wageOrder: '', employeeIds: new Set(), identities };
  const ids = identities.map((identity) => identity.employeeId);
  const regions = await workRegionsOf(ids);
  const inRegion = ids.filter((id) => regions.get(id) === region);
  const [salaries, settings] = await Promise.all([
    salariesOn(inRegion, checkedOn),
    payrollSettingVersionOn('talent.payrollSettings', checkedOn),
  ]);
  const below = new Set<string>();
  for (const [employeeId, salary] of salaries) {
    if (!settings && salary.rateType === 'monthly') continue;
    if (
      isBelowMinimumWage(
        salary.amountCentavos,
        salary.rateType,
        row.dailyRateCentavos,
        settings?.value.dailyRateFactor ?? 1,
      )
    ) {
      below.add(employeeId);
    }
  }
  return { checkedOn, wageOrder: row.wageOrder, employeeIds: below, identities };
}

/**
 * For each `talent.minimumWages` version and each region in it, the count of active employees
 * paid below it. Talent Read and HR, Accounting or the System Administrator. Not audit-logged.
 */
export async function countEmployeesBelowMinimumWage(
  actor: TalentActor,
): Promise<MinimumWageBelowCount[]> {
  assertCanViewWageOrderList(actor);
  await connectDb();
  const versions = await listConfigVersions(MINIMUM_WAGES_SETTING);
  const counts: MinimumWageBelowCount[] = [];
  for (const version of versions) {
    for (const { region } of version.value.regions) {
      const result = await employeesBelow(actor, version.value, version.effectiveFrom, region);
      counts.push({
        versionId: version.id,
        region,
        checkedOn: result.checkedOn,
        count: result.employeeIds.size,
      });
    }
  }
  return counts;
}

/**
 * "View list" on a minimum wage version: the active employees in `region` paid below it, by last
 * name. Names, numbers, departments and positions only, never an amount. Talent Read and HR,
 * Accounting or the System Administrator. Not audit-logged. Null when there is no such version or
 * region in it.
 */
export async function listEmployeesBelowMinimumWage(
  actor: TalentActor,
  { versionId, region }: { versionId: string; region: WorkRegion },
): Promise<BelowMinimumWageList | null> {
  assertCanViewWageOrderList(actor);
  await connectDb();
  const version = (await listConfigVersions(MINIMUM_WAGES_SETTING)).find((v) => v.id === versionId);
  if (!version || !minimumWageForRegion(version.value, region)) return null;
  const result = await employeesBelow(actor, version.value, version.effectiveFrom, region);
  const rows = result.identities
    .filter((identity) => result.employeeIds.has(identity.employeeId))
    .map((identity): BelowMinimumWageRow => ({
      employeeId: identity.employeeId,
      name: `${identity.firstName} ${identity.lastName}`,
      employeeNumber: identity.employeeNumber,
      department: identity.department,
      position: identity.position
        ? { id: identity.position.id, name: identity.position.name }
        : null,
      href: `/talent?employee=${identity.employeeId}`,
    }));
  return { versionId, region, wageOrder: result.wageOrder, checkedOn: result.checkedOn, rows };
}
