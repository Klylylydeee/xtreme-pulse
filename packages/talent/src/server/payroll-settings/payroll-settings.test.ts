import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Types } from 'mongoose';
import { connectDb } from '@pulse/db';
import { AccessDeniedError, ActionError, addDays, businessToday } from '@pulse/core';
import type { z } from 'zod';
import { addConfigVersion, type ConfigSetting, listConfigVersions } from '@pulse/core/server';
import { latestEffectiveDate } from '../../compensation';
import { PAYROLL_SETTING_KEYS, PAYROLL_SETTING_SCHEMAS } from '../../payroll/schemas';
import { talentSeedLoaders } from '../seed';
import {
  auditEntries,
  countAudit,
  type Department,
  department,
  type Person,
  person,
} from '../testing/fixtures';
import {
  PAYROLL_SEED_VERSIONS,
  SEED_ALLOWANCE_TYPES,
  SEED_PAYROLL_SETTINGS,
  SEED_PREMIUM_RATES,
  SEED_REIMBURSEMENT_SETTINGS,
  SEED_THIRTEENTH_MONTH_EXEMPTION,
} from './seed-data';
import { addPayrollSettingsVersion, getPayrollSettingsView } from './service';
import {
  PAYROLL_SETTINGS,
  PREMIUM_RATES_SETTING,
  REIMBURSEMENT_SETTINGS_SETTING,
  THIRTEENTH_MONTH_EXEMPTION_SETTING,
} from './settings';

// The payroll settings tests: seeding and adding a version (docs/TESTING.md#payroll-settings-tests,
// build step 2.3, decisions 196–198 in docs/BUILD_PLAN.md; the step 2.4 settings, and from step
// 2.5 `talent.reimbursementSettings`, decisions 235 and 236, docs/TESTING.md#reimbursement-tests).
// Made-up people only.

let NET: Department;
let HRD: Department;
let hrOwner: Person;
let hrWriter: Person;
let netOwner: Person;
let adminOwner: Person;
let reader: Person;

/** A number that isn't a safe integer, anywhere in a value. */
function hasFractionalNumber(value: unknown): boolean {
  if (typeof value === 'number') return !Number.isSafeInteger(value);
  if (Array.isArray(value)) return value.some(hasFractionalNumber);
  if (value && typeof value === 'object') return Object.values(value).some(hasFractionalNumber);
  return false;
}

async function runSeed() {
  const results: Record<string, { added: number; skipped: number }> = {};
  for (const loader of talentSeedLoaders) results[loader.name] = await loader.run();
  return results;
}

// A fixed "today" (only Date is faked), so a version's status and the date limits don't depend on
// when the tests run.
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-12T10:00:00+08:00'));
});

afterEach(() => {
  vi.useRealTimers();
});

beforeAll(async () => {
  await connectDb();
  NET = await department('Network', 'NET');
  HRD = await department('Human Resource', 'HR');
  hrOwner = await person('Hana', 'Reyes', HRD, { talent: 'owner' });
  hrWriter = await person('Hilda', 'Ramos', HRD, { talent: 'write' });
  netOwner = await person('Oscar', 'Tan', NET, { talent: 'owner' });
  adminOwner = await person('Ada', 'Admin', NET, { admin: true });
  reader = await person('Rita', 'Lopez', NET, { talent: 'read' });
});

describe('seed data', () => {
  it('passes every schema, has no fractional number and a source on every version', () => {
    for (const key of PAYROLL_SETTING_KEYS) {
      const seeds = PAYROLL_SEED_VERSIONS[key];
      expect(seeds.length).toBeGreaterThan(0);
      for (const seed of seeds) {
        expect(PAYROLL_SETTING_SCHEMAS[key].safeParse(seed.value).success, key).toBe(true);
        expect(hasFractionalNumber(seed.value), key).toBe(false);
        expect(seed.source.length).toBeGreaterThan(0);
        expect(seed.source.length).toBeLessThanOrEqual(300);
      }
    }
  });

  it('seeds NCR-26 and NCR-28 as two versions, and the policy settings from 2000-01-01', () => {
    expect(
      PAYROLL_SEED_VERSIONS['talent.minimumWages'].map((v) => [v.effectiveFrom, v.value.regions]),
    ).toEqual([
      ['2025-07-18', [{ region: 'NCR', wageOrder: 'Wage Order NCR-26', dailyRateCentavos: 69500 }]],
      ['2026-09-26', [{ region: 'NCR', wageOrder: 'Wage Order NCR-28', dailyRateCentavos: 75500 }]],
    ]);
    for (const key of [
      'talent.payrollSettings',
      'talent.allowanceTypes',
      'talent.premiumRates',
      'talent.workSchedule',
      'talent.timesheetSettings',
      'talent.reimbursementSettings',
    ] as const) {
      expect(PAYROLL_SEED_VERSIONS[key][0]?.effectiveFrom).toBe('2000-01-01');
    }
    expect(PAYROLL_SEED_VERSIONS['talent.deMinimisLimits'][0]?.effectiveFrom).toBe('2026-01-06');
    expect(SEED_THIRTEENTH_MONTH_EXEMPTION.exemptCeilingCentavos).toBe(9000000);
    expect(SEED_ALLOWANCE_TYPES.types).toEqual([
      expect.objectContaining({
        key: 'internet',
        defaultAmountCentavos: 50000,
        autoAssign: true,
        taxTreatment: 'nonTaxable',
      }),
    ]);
  });
});

describe('the step 2.4 settings', () => {
  it('makes thirteen payroll settings: the work schedule and timesheet settings, then the reimbursement settings, last', () => {
    expect(PAYROLL_SETTING_KEYS).toHaveLength(13);
    expect(PAYROLL_SETTING_KEYS.slice(10)).toEqual([
      'talent.workSchedule',
      'talent.timesheetSettings',
      'talent.reimbursementSettings',
    ]);
  });

  it('seeds the default schedule and the timesheet settings once, from the spec', () => {
    expect(PAYROLL_SEED_VERSIONS['talent.workSchedule']).toEqual([
      {
        effectiveFrom: '2000-01-01',
        source: 'Company policy (spec)',
        value: {
          workDays: [1, 2, 3, 4, 5],
          start: '08:00',
          end: '17:00',
          breakStart: '12:00',
          breakMinutes: 60,
          graceMinutes: 15,
        },
      },
    ]);
    expect(PAYROLL_SEED_VERSIONS['talent.timesheetSettings']).toEqual([
      {
        effectiveFrom: '2000-01-01',
        source: 'Company policy (spec)',
        value: { offsetRatio: '1', extraHours: { overtime: 'overtime', standard: 'offset' } },
      },
    ]);
  });
});

describe('the step 2.5 setting', () => {
  it('seeds the reimbursement settings once, from the spec', () => {
    expect(PAYROLL_SEED_VERSIONS['talent.reimbursementSettings']).toEqual([
      {
        effectiveFrom: '2000-01-01',
        source: 'Company policy (spec)',
        value: SEED_REIMBURSEMENT_SETTINGS,
      },
    ]);
    expect(SEED_REIMBURSEMENT_SETTINGS).toEqual({
      filingWindowPreviousCutOffs: 1,
      types: [
        {
          key: 'meal',
          name: 'Meal',
          active: true,
          requiresRoute: false,
          requiresDescription: false,
          requiresClient: false,
          limit: null,
        },
        {
          key: 'transportation',
          name: 'Transportation',
          active: true,
          requiresRoute: true,
          requiresDescription: false,
          requiresClient: false,
          limit: null,
        },
        {
          key: 'other',
          name: 'Other',
          active: true,
          requiresRoute: false,
          requiresDescription: true,
          requiresClient: false,
          limit: null,
        },
      ],
    });
  });
});

describe('seeding', () => {
  it('adds each setting’s versions once, leaves a setting that has a version alone, and writes no audit entry', async () => {
    // A setting that already has a version is left alone.
    await addConfigVersion(THIRTEENTH_MONTH_EXEMPTION_SETTING, {
      effectiveFrom: '2019-01-01',
      value: { exemptCeilingCentavos: 12345600 },
      source: 'Made-up earlier version',
      actorId: null,
    });
    const auditBefore = await countAudit();
    expect(talentSeedLoaders.map((loader) => loader.name)).toEqual([
      ...PAYROLL_SETTING_KEYS,
      'talent.onboardingSettings',
    ]);

    const first = await runSeed();
    expect(first['talent.minimumWages']).toEqual({ added: 2, skipped: 0 });
    expect(first['talent.sssContributions']).toEqual({ added: 1, skipped: 0 });
    expect(first['talent.thirteenthMonthExemption']).toEqual({ added: 0, skipped: 1 });
    const thirteenth = await listConfigVersions(THIRTEENTH_MONTH_EXEMPTION_SETTING);
    expect(thirteenth.map((v) => v.value.exemptCeilingCentavos)).toEqual([12345600]);

    const second = await runSeed();
    for (const key of PAYROLL_SETTING_KEYS) expect(second[key]?.added, key).toBe(0);
    for (const key of PAYROLL_SETTING_KEYS) {
      if (key === 'talent.thirteenthMonthExemption') continue;
      const versions = await listConfigVersions(PAYROLL_SETTINGS[key] as ConfigSetting<z.ZodType>);
      expect(versions.length, key).toBe(PAYROLL_SEED_VERSIONS[key].length);
      for (const version of versions) expect(version.source, key).toBeTruthy();
    }
    expect(await countAudit()).toBe(auditBefore);
    const reimbursements = await listConfigVersions(REIMBURSEMENT_SETTINGS_SETTING);
    expect(reimbursements.map((v) => [v.effectiveFrom, v.source, v.value])).toEqual([
      ['2000-01-01', 'Company policy (spec)', SEED_REIMBURSEMENT_SETTINGS],
    ]);
  });
});

describe('the view', () => {
  it('needs Talent Read and shows the version in effect, scheduled versions and the history', async () => {
    await expect(
      getPayrollSettingsView((await person('No', 'Access', NET)).actor),
    ).rejects.toBeInstanceOf(AccessDeniedError);
    const view = await getPayrollSettingsView(reader.actor);
    expect(view.canAddVersion).toBe(false);
    expect(view.minimumWageBelow).toBeUndefined();
    const sss = view.settings['talent.sssContributions'];
    expect(sss.inEffect?.effectiveFrom).toBe('2025-01-01');
    expect(sss.inEffect?.seeded).toBe(true);
    expect(sss.inEffect?.value.rows).toHaveLength(61);
    const wages = view.settings['talent.minimumWages'];
    expect(view.today).toBe('2026-10-12');
    expect(wages.history.map((v) => [v.effectiveFrom, v.status])).toEqual([
      ['2026-09-26', 'inEffect'],
      ['2025-07-18', 'past'],
    ]);
    expect(wages.scheduled).toEqual([]);
    expect(wages.earliestEffectiveFrom).toBe('2026-09-27');
    expect(wages.latestEffectiveFrom).toBe('2027-10-12');
    expect((await getPayrollSettingsView(hrOwner.actor)).canAddVersion).toBe(true);
  });

  it('shows NCR-28 as scheduled before 2026-09-26', async () => {
    vi.setSystemTime(new Date('2026-09-01T10:00:00+08:00'));
    const wages = (await getPayrollSettingsView(reader.actor)).settings['talent.minimumWages'];
    expect(wages.history.map((v) => [v.effectiveFrom, v.status])).toEqual([
      ['2026-09-26', 'scheduled'],
      ['2025-07-18', 'inEffect'],
    ]);
    expect(wages.inEffect?.effectiveFrom).toBe('2025-07-18');
    expect(wages.scheduled.map((v) => v.effectiveFrom)).toEqual(['2026-09-26']);
  });
});

describe('adding a version', () => {
  const premium = (effectiveFrom: string, nightDifferentialAddOn = '0.15') => ({
    key: 'talent.premiumRates' as const,
    effectiveFrom,
    source: 'Made-up DOLE advisory',
    value: { ...SEED_PREMIUM_RATES, nightDifferentialAddOn },
  });

  it('needs Talent Owner and HR or the System Administrator', async () => {
    const before = (await listConfigVersions(PREMIUM_RATES_SETTING)).length;
    await expect(
      addPayrollSettingsVersion(netOwner.actor, premium('2026-01-02')),
    ).rejects.toBeInstanceOf(AccessDeniedError);
    await expect(
      addPayrollSettingsVersion(hrWriter.actor, premium('2026-01-02')),
    ).rejects.toBeInstanceOf(AccessDeniedError);
    await expect(
      addPayrollSettingsVersion(reader.actor, premium('2026-01-02')),
    ).rejects.toBeInstanceOf(AccessDeniedError);
    expect((await listConfigVersions(PREMIUM_RATES_SETTING)).length).toBe(before);
  });

  it('writes the create entry on core.configVersion in the same transaction', async () => {
    const added = await addPayrollSettingsVersion(hrOwner.actor, premium('2026-01-02'));
    expect(added.effectiveFrom).toBe('2026-01-02');
    const entries = (await auditEntries('core.configVersion')).filter(
      (entry) => entry.record.id.toHexString() === added.id,
    );
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      module: 'core',
      action: 'create',
      record: { label: 'talent.premiumRates from 2026-01-02' },
      actorId: new Types.ObjectId(hrOwner.userId),
    });
    expect(entries[0]?.after?.source).toBe('Made-up DOLE advisory');
    const view = await getPayrollSettingsView(reader.actor);
    expect(view.settings['talent.premiumRates'].inEffect).toMatchObject({
      id: added.id,
      seeded: false,
    });
  });

  it('refuses a date on or before the latest version, more than a year ahead, or a same-day collision', async () => {
    await expect(
      addPayrollSettingsVersion(adminOwner.actor, premium('2026-01-02')),
    ).rejects.toThrow(/already takes effect/);
    await expect(
      addPayrollSettingsVersion(adminOwner.actor, premium('2026-01-01')),
    ).rejects.toThrow(/must be after/);
    const tooLate = addDays(latestEffectiveDate(businessToday()), 1);
    await expect(
      addPayrollSettingsVersion(adminOwner.actor, premium(tooLate)),
    ).rejects.toBeInstanceOf(ActionError);
    // Past dates are allowed, as long as they are after the latest version.
    await addPayrollSettingsVersion(adminOwner.actor, premium('2026-01-03', '0.10'));
  });

  it('refuses a source missing or over 300 characters, and an invalid value', async () => {
    await expect(
      addPayrollSettingsVersion(adminOwner.actor, { ...premium('2026-02-01'), source: '  ' }),
    ).rejects.toMatchObject({ field: 'source' });
    await expect(
      addPayrollSettingsVersion(adminOwner.actor, {
        ...premium('2026-02-01'),
        source: 'x'.repeat(301),
      }),
    ).rejects.toMatchObject({ field: 'source' });
    await expect(
      addPayrollSettingsVersion(adminOwner.actor, {
        key: 'talent.thirteenthMonthExemption',
        effectiveFrom: '2026-02-01',
        source: 'Made up',
        value: { exemptCeilingCentavos: 1.5 },
      }),
    ).rejects.toMatchObject({ field: 'value.exemptCeilingCentavos' });
  });

  it('refuses a pay schedule not starting on a cut-off start day', async () => {
    const schedule = (effectiveFrom: string) => ({
      key: 'talent.payrollSettings' as const,
      effectiveFrom,
      source: 'Made-up policy change',
      value: { ...SEED_PAYROLL_SETTINGS, dailyRateFactor: 262 },
    });
    await expect(addPayrollSettingsVersion(hrOwner.actor, schedule('2026-11-01'))).rejects.toThrow(
      /cut-off start day/,
    );
    await addPayrollSettingsVersion(hrOwner.actor, schedule('2026-11-26'));
  });

  it('takes a work schedule or timesheet settings version on any day, and checks its value', async () => {
    const workSchedule = (value: object) => ({
      key: 'talent.workSchedule' as const,
      effectiveFrom: '2026-11-04',
      source: 'Made-up policy change',
      value,
    });
    const seeded = PAYROLL_SEED_VERSIONS['talent.workSchedule'][0]?.value;
    await expect(
      addPayrollSettingsVersion(hrOwner.actor, workSchedule({ ...seeded, breakStart: '18:00' })),
    ).rejects.toMatchObject({ field: 'value.breakStart' });
    await expect(
      addPayrollSettingsVersion(hrOwner.actor, workSchedule({ ...seeded, workDays: [] })),
    ).rejects.toMatchObject({ field: 'value.workDays' });
    // A Wednesday: not a cut-off start day, unlike the pay schedule.
    const added = await addPayrollSettingsVersion(
      hrOwner.actor,
      workSchedule({ ...seeded, start: '09:00', end: '18:00', breakStart: '13:00' }),
    );
    expect(added.effectiveFrom).toBe('2026-11-04');

    const settings = (offsetRatio: string) => ({
      key: 'talent.timesheetSettings' as const,
      effectiveFrom: '2026-11-04',
      source: 'Made-up policy change',
      value: { offsetRatio, extraHours: { overtime: 'overtime', standard: 'offset' } },
    });
    await expect(addPayrollSettingsVersion(hrOwner.actor, settings('0'))).rejects.toMatchObject({
      field: 'value.offsetRatio',
    });
    await addPayrollSettingsVersion(hrOwner.actor, settings('1.5'));
  });

  it('refuses removing an allowance type key', async () => {
    await expect(
      addPayrollSettingsVersion(hrOwner.actor, {
        key: 'talent.allowanceTypes',
        effectiveFrom: '2026-12-01',
        source: 'Made-up policy change',
        value: { types: [] },
      }),
    ).rejects.toThrow(/never removed/);
    await addPayrollSettingsVersion(hrOwner.actor, {
      key: 'talent.allowanceTypes',
      effectiveFrom: '2026-12-01',
      source: 'Made-up policy change',
      value: { types: SEED_ALLOWANCE_TYPES.types.map((type) => ({ ...type, active: false })) },
    });
  });

  it('refuses removing a reimbursement type key, takes a new limit, and checks the value', async () => {
    const reimbursements = (value: object) => ({
      key: 'talent.reimbursementSettings' as const,
      effectiveFrom: '2026-11-04',
      source: 'Made-up policy change',
      value,
    });
    await expect(
      addPayrollSettingsVersion(
        hrOwner.actor,
        reimbursements({
          ...SEED_REIMBURSEMENT_SETTINGS,
          types: SEED_REIMBURSEMENT_SETTINGS.types.filter((type) => type.key !== 'other'),
        }),
      ),
    ).rejects.toThrow(/never removed: keep other/);
    await expect(
      addPayrollSettingsVersion(
        hrOwner.actor,
        reimbursements({ ...SEED_REIMBURSEMENT_SETTINGS, filingWindowPreviousCutOffs: 7 }),
      ),
    ).rejects.toMatchObject({ field: 'value.filingWindowPreviousCutOffs' });
    await expect(
      addPayrollSettingsVersion(netOwner.actor, reimbursements({ ...SEED_REIMBURSEMENT_SETTINGS })),
    ).rejects.toBeInstanceOf(AccessDeniedError);
    // A Wednesday is fine; a meal limit of ₱500.00 a day, and "other" marked inactive.
    const added = await addPayrollSettingsVersion(
      hrOwner.actor,
      reimbursements({
        ...SEED_REIMBURSEMENT_SETTINGS,
        types: SEED_REIMBURSEMENT_SETTINGS.types.map((type) =>
          type.key === 'meal'
            ? { ...type, limit: { amountCentavos: 50000, per: 'day' } }
            : type.key === 'other'
              ? { ...type, active: false }
              : type,
        ),
      }),
    );
    expect(added.effectiveFrom).toBe('2026-11-04');
    const versions = await listConfigVersions(REIMBURSEMENT_SETTINGS_SETTING);
    expect(versions[0]?.value.types[0]?.limit).toEqual({ amountCentavos: 50000, per: 'day' });
    const entries = (await auditEntries('core.configVersion')).filter(
      (entry) => entry.record.id.toHexString() === added.id,
    );
    expect(entries).toHaveLength(1);
    expect(entries[0]?.record.label).toBe('talent.reimbursementSettings from 2026-11-04');
  });
});
