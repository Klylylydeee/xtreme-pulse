import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Types } from 'mongoose';
import { connectDb } from '@pulse/db';
import { AccessDeniedError } from '@pulse/core';
import { listConfigVersions } from '@pulse/core/server';
import { addCompensationEntry } from '../compensation/service';
import { CompensationEntryModel } from '../compensation/model';
import { getEmployeeRecordView, updateEmployment } from '../employee-records/service';
import { MINIMUM_WAGES_SETTING } from '../payroll-settings/settings';
import {
  auditEntries,
  type Department,
  department,
  type Person,
  person,
  savedId,
  seedPayrollSettings,
  separate,
} from '../testing/fixtures';
import { COMPENSATION_ENTRY_TYPE } from '../../views';
import { countEmployeesBelowMinimumWage, listEmployeesBelowMinimumWage } from './service';

/** The value, failing the test when it is missing. */
function defined<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error('Expected a value.');
  return value;
}

// The minimum wage tests (docs/TESTING.md#payroll-settings-tests, build step 2.3, decisions
// 205–207 in docs/BUILD_PLAN.md; the step's "Done when": a salary below NCR minimum wage shows a
// warning on save). The seeded NCR versions: ₱695 from 2025-07-18 and ₱755 from 2026-09-26.
// Made-up people and salaries.

let NET: Department;
let HRD: Department;
let ACCT: Department;
let hr: Person;
let hrNoTalent: Person;
let accountant: Person;
let reader: Person;

beforeAll(async () => {
  await connectDb();
  await CompensationEntryModel.init();
  await seedPayrollSettings();
  NET = await department('Network', 'NET');
  HRD = await department('Human Resource', 'HR');
  ACCT = await department('Accounting', 'ACCT');
  hr = await person('Hana', 'Reyes', HRD, { talent: 'write' });
  hrNoTalent = await person('Hugo', 'Rivera', HRD);
  accountant = await person('Alma', 'Santos', ACCT, { talent: 'read' });
  reader = await person('Rita', 'Lopez', NET, { talent: 'read' });
});

// A fixed "today", after NCR-28 took effect (2026-09-26), so the warning, the badge, the
// scheduled salary and the wage order list mean the same thing whenever the tests run. Only Date
// is faked.
const TODAY = new Date('2026-10-12T10:00:00+08:00');

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(TODAY);
});

afterEach(() => {
  vi.useRealTimers();
});

function salary(
  subject: Person,
  effectiveDate: string,
  basicSalaryCentavos: number,
  {
    rateType = 'monthly',
    allowBelowMinimumWage = false,
  }: { rateType?: 'monthly' | 'daily'; allowBelowMinimumWage?: boolean } = {},
) {
  return addCompensationEntry(hr.actor, {
    employeeId: subject.employeeId,
    effectiveDate,
    basicSalaryCentavos,
    rateType,
    minimumWageEarner: false,
    reason: 'Made-up salary',
    allowBelowMinimumWage,
  });
}

const entriesOf = (subject: Person) =>
  CompensationEntryModel.find({ employeeId: new Types.ObjectId(subject.employeeId) }).lean();

describe('the warning on save (the step’s "Done when")', () => {
  it('saves nothing below the minimum without the confirmation and returns the warning', async () => {
    const subject = await person('Ana', 'Bello', NET);
    const auditBefore = (await auditEntries(COMPENSATION_ENTRY_TYPE)).length;
    const result = await salary(subject, '2026-10-01', 1642124);
    expect(result).toEqual({
      status: 'belowMinimumWage',
      warning: expect.objectContaining({
        region: 'NCR',
        wageOrder: 'Wage Order NCR-28',
        minimumDailyRateCentavos: 75500,
        // ₱754.9995… a day, rounded down so it never reads as the minimum itself.
        dailyRateCentavos: 75499,
        message:
          'The daily rate ₱754.99 is below the NCR minimum wage of ₱755.00 (Wage Order NCR-28). It will be flagged in payroll.',
      }),
    });
    expect(await entriesOf(subject)).toEqual([]);
    expect((await auditEntries(COMPENSATION_ENTRY_TYPE)).length).toBe(auditBefore);

    const daily = await salary(subject, '2026-10-01', 65000, { rateType: 'daily' });
    expect(daily.status === 'belowMinimumWage' && daily.warning.message).toBe(
      'The daily rate ₱650.00 is below the NCR minimum wage of ₱755.00 (Wage Order NCR-28). It will be flagged in payroll.',
    );
  });

  it('saves with "Save anyway" and stores minimumWageWarningConfirmed', async () => {
    const subject = await person('Berto', 'Cosme', NET);
    const result = await salary(subject, '2026-10-01', 1642124, { allowBelowMinimumWage: true });
    expect(result.status).toBe('saved');
    const [stored] = await entriesOf(subject);
    expect(stored?.minimumWageWarningConfirmed).toBe(true);
    const atMinimum = await salary(subject, '2026-10-02', 1642125);
    expect(atMinimum.status).toBe('saved');
    expect((await salary(subject, '2026-10-03', 75500, { rateType: 'daily' })).status).toBe(
      'saved',
    );
    expect((await salary(subject, '2026-10-04', 75499, { rateType: 'daily' })).status).toBe(
      'belowMinimumWage',
    );
    const plain = await CompensationEntryModel.findById(savedId(atMinimum).id).lean();
    expect(plain?.minimumWageWarningConfirmed).toBeUndefined();
  });

  it('saves with a note when the region has no minimum wage', async () => {
    const subject = await person('Cita', 'Dumlao', NET);
    await updateEmployment(hr.actor, {
      employeeId: subject.employeeId,
      version: 0,
      workRegion: 'CAR',
      contractEndDate: null,
      regularizationDate: null,
      separationRemarks: null,
    });
    const result = await salary(subject, '2026-10-01', 100000);
    expect(result).toEqual({
      status: 'savedWithNote',
      id: expect.any(String),
      note: 'No minimum wage on file for CAR. Add it in Payroll settings.',
    });
    expect(await entriesOf(subject)).toHaveLength(1);
  });

  it('uses the later of the effective date and today: ₱695 before 2026-09-26', async () => {
    vi.setSystemTime(new Date('2026-09-01T10:00:00+08:00'));
    const subject = await person('Dado', 'Esguerra', NET);
    const below = await salary(subject, '2026-09-01', 1511624);
    expect(below.status === 'belowMinimumWage' && below.warning.wageOrder).toBe(
      'Wage Order NCR-26',
    );
    expect((await salary(subject, '2026-09-01', 1511625)).status).toBe('saved');
    // An effective date after NCR-28 takes effect is checked against ₱755.
    const later = await salary(subject, '2026-10-01', 1600000);
    expect(later.status === 'belowMinimumWage' && later.warning).toMatchObject({
      wageOrder: 'Wage Order NCR-28',
      dailyRateCentavos: 73563,
      checkedOn: '2026-10-01',
    });
    // A past effective date is checked against today's minimum.
    vi.setSystemTime(TODAY);
    const past = await salary(subject, '2026-09-01', 1600000);
    expect(past.status === 'belowMinimumWage' && past.warning.checkedOn).toBe('2026-10-12');
  });
});

describe('the badge', () => {
  it('shows only for a current salary below today’s minimum, and only in Compensation', async () => {
    const below = await person('Ely', 'Fajardo', NET);
    savedId(await salary(below, '2026-01-01', 1600000, { allowBelowMinimumWage: true }));
    expect(
      (await getEmployeeRecordView(hr.actor, below.employeeId))?.compensation?.belowMinimumWage,
    ).toBe(true);

    const above = await person('Fe', 'Garcia', NET);
    savedId(await salary(above, '2026-01-01', 2000000));
    expect(
      (await getEmployeeRecordView(hr.actor, above.employeeId))?.compensation?.belowMinimumWage,
    ).toBe(false);

    // A scheduled salary below the minimum doesn't count until it is current.
    savedId(await salary(above, '2027-06-01', 1600000, { allowBelowMinimumWage: true }));
    expect(
      (await getEmployeeRecordView(hr.actor, above.employeeId))?.compensation?.belowMinimumWage,
    ).toBe(false);

    const forReader = await getEmployeeRecordView(reader.actor, below.employeeId);
    expect(forReader?.compensation).toBeUndefined();
    expect(JSON.stringify(forReader)).not.toContain('belowMinimumWage');
  });
});

describe('the wage order list', () => {
  it('counts and lists the active employees in the region below a version, with no amounts', async () => {
    const versions = await listConfigVersions(MINIMUM_WAGES_SETTING);
    const ncr28 = defined(versions.find((v) => v.effectiveFrom === '2026-09-26'));
    const ncr26 = defined(versions.find((v) => v.effectiveFrom === '2025-07-18'));

    const belowA = await person('Gina', 'Lim', NET);
    savedId(await salary(belowA, '2026-01-01', 1600000, { allowBelowMinimumWage: true }));
    const aboveB = await person('Hector', 'Mata', NET);
    savedId(await salary(aboveB, '2026-01-01', 1700000));
    const otherRegion = await person('Ines', 'Navarro', NET);
    await updateEmployment(hr.actor, {
      employeeId: otherRegion.employeeId,
      version: 0,
      workRegion: 'CAR',
      contractEndDate: null,
      regularizationDate: null,
      separationRemarks: null,
    });
    savedId(await salary(otherRegion, '2026-01-01', 1000000));
    const leaver = await person('Jose', 'Ocampo', NET);
    savedId(await salary(leaver, '2026-01-01', 1000000, { allowBelowMinimumWage: true }));
    await separate(leaver);

    const list = await listEmployeesBelowMinimumWage(hr.actor, {
      versionId: ncr28.id,
      region: 'NCR',
    });
    const ids = list?.rows.map((row) => row.employeeId) ?? [];
    expect(ids).toContain(belowA.employeeId);
    expect(ids).not.toContain(aboveB.employeeId);
    expect(ids).not.toContain(otherRegion.employeeId);
    expect(ids).not.toContain(leaver.employeeId);
    expect(list?.wageOrder).toBe('Wage Order NCR-28');
    const row = list?.rows.find((r) => r.employeeId === belowA.employeeId);
    expect(row).toEqual({
      employeeId: belowA.employeeId,
      name: 'Gina Lim',
      employeeNumber: belowA.employeeNumber,
      department: expect.objectContaining({ code: 'NET' }),
      position: expect.objectContaining({ name: 'Network Specialist' }),
      href: `/talent?employee=${belowA.employeeId}`,
    });
    expect(JSON.stringify(list)).not.toContain('1600000');

    const counts = await countEmployeesBelowMinimumWage(accountant.actor);
    expect(counts.find((c) => c.versionId === ncr28.id && c.region === 'NCR')?.count).toBe(
      list?.rows.length,
    );
    // ₱16,000 isn't below ₱695 (the threshold is ₱15,116.25).
    const old = await listEmployeesBelowMinimumWage(hr.actor, {
      versionId: ncr26.id,
      region: 'NCR',
    });
    expect(old?.rows.map((r) => r.employeeId)).not.toContain(belowA.employeeId);
    expect(
      await listEmployeesBelowMinimumWage(hr.actor, { versionId: ncr28.id, region: 'CAR' }),
    ).toBeNull();
  });

  it('is refused without Talent Read, or outside HR, Accounting and the System Administrator', async () => {
    const versions = await listConfigVersions(MINIMUM_WAGES_SETTING);
    const versionId = defined(versions[0]).id;
    await expect(
      listEmployeesBelowMinimumWage(reader.actor, { versionId, region: 'NCR' }),
    ).rejects.toBeInstanceOf(AccessDeniedError);
    await expect(
      listEmployeesBelowMinimumWage(hrNoTalent.actor, { versionId, region: 'NCR' }),
    ).rejects.toBeInstanceOf(AccessDeniedError);
    await expect(countEmployeesBelowMinimumWage(reader.actor)).rejects.toBeInstanceOf(
      AccessDeniedError,
    );
    expect(
      await listEmployeesBelowMinimumWage(accountant.actor, { versionId, region: 'NCR' }),
    ).not.toBeNull();
  });
});
