import { describe, expect, it } from 'vitest';
import { formatPeso, parsePesos, ratio, scaleCentavos } from '@pulse/core';
import {
  SEED_DE_MINIMIS_LIMITS,
  SEED_MINIMUM_WAGES_NCR_26,
  SEED_MINIMUM_WAGES_NCR_28,
  SEED_PAGIBIG_CONTRIBUTIONS,
  SEED_PAYROLL_SETTINGS,
  SEED_PHILHEALTH_CONTRIBUTIONS,
  SEED_SSS_CONTRIBUTIONS,
  SEED_WITHHOLDING_TAX_SEMI_MONTHLY,
} from '../server/payroll-settings/seed-data';
import { resolveAllowances } from './allowances';
import {
  cutOffFor,
  dailyRateCentavos,
  deMinimisLimitCentavos,
  isBelowMinimumWage,
  isCutOffStart,
  pagibigShares,
  philhealthShares,
  semiMonthlyWithholding,
  splitContribution,
  sssRowFor,
} from './lookups';
import { minimumWageWarningFor } from './minimum-wage';
import {
  type AllowanceType,
  allowanceTypeSchema,
  allowanceTypesSchema,
  deMinimisLimitsSchema,
  pagibigContributionsSchema,
  payrollSettingsSchema,
  removedAllowanceTypeKeys,
  sssContributionsSchema,
  withholdingTaxSemiMonthlySchema,
} from './schemas';
import { allowanceAssignmentFormSchema } from './validation';

/** The value, failing the test when it is missing. */
function defined<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error('Expected a value.');
  return value;
}

// The payroll settings tests, pure part (docs/TESTING.md#payroll-settings-tests, build step 2.3).
// Every figure is worked by hand from the seeded rates in docs/COMPLIANCE.md#seeded-payroll-rates-build-step-23;
// the tests test the seed data, not a database.

const pesos = (amount: number) => parsePesos(String(amount));

describe('SSS (sssRowFor)', () => {
  it('has 61 generated rows', () => {
    expect(SEED_SSS_CONTRIBUTIONS.rows).toHaveLength(61);
  });

  it.each([
    // compensation, MSC, regular, MPF, employee, employer, EC
    [4000, 5000, 5000, 0, 250, 500, 10],
    [14749.99, 14500, 14500, 0, 725, 1450, 10],
    [14750, 15000, 15000, 0, 750, 1500, 30],
    [20000, 20000, 20000, 0, 1000, 2000, 30],
    [25000, 25000, 20000, 5000, 1250, 2500, 30],
    [50000, 35000, 20000, 15000, 1750, 3500, 30],
  ])('₱%s → MSC ₱%s', (comp, msc, regular, mpf, employee, employer, ec) => {
    const row = sssRowFor(pesos(comp), SEED_SSS_CONTRIBUTIONS);
    expect(row.mscCentavos).toBe(pesos(msc));
    expect(row.regularMscCentavos).toBe(pesos(regular));
    expect(row.mpfMscCentavos).toBe(pesos(mpf));
    expect(row.employee.totalCentavos).toBe(pesos(employee));
    expect(row.employer.totalCentavos).toBe(pesos(employer));
    expect(row.ecCentavos).toBe(pesos(ec));
  });

  it('splits ₱25,000 into regular SS and MPF', () => {
    const row = sssRowFor(pesos(25000), SEED_SSS_CONTRIBUTIONS);
    expect(row.employee).toEqual({
      regularCentavos: pesos(1000),
      mpfCentavos: pesos(250),
      totalCentavos: pesos(1250),
    });
    expect(row.employer).toEqual({
      regularCentavos: pesos(2000),
      mpfCentavos: pesos(500),
      totalCentavos: pesos(2500),
    });
  });

  it('refuses rows out of order, not starting at 0, or MPF shares with no MPF credit', () => {
    const rows = SEED_SSS_CONTRIBUTIONS.rows;
    expect(sssContributionsSchema.safeParse({ rows }).success).toBe(true);
    expect(sssContributionsSchema.safeParse({ rows: [rows[1], rows[0]] }).success).toBe(false);
    expect(sssContributionsSchema.safeParse({ rows: rows.slice(1) }).success).toBe(false);
    const bad = { ...defined(rows[0]), employee: { regularCentavos: 25000, mpfCentavos: 1 } };
    expect(sssContributionsSchema.safeParse({ rows: [bad] }).success).toBe(false);
  });
});

describe('PhilHealth (philhealthShares)', () => {
  it.each([
    [8000, 10000, 500, 250],
    [25000, 25000, 1250, 625],
    [150000, 100000, 5000, 2500],
  ])('₱%s → basis ₱%s → premium ₱%s, employee ₱%s', (salary, basis, premium, employee) => {
    const shares = philhealthShares(pesos(salary), SEED_PHILHEALTH_CONTRIBUTIONS);
    expect(shares.basisCentavos).toBe(pesos(basis));
    expect(shares.premiumCentavos).toBe(pesos(premium));
    expect(shares.employeeCentavos).toBe(pesos(employee));
    expect(shares.employeeCentavos + shares.employerCentavos).toBe(shares.premiumCentavos);
  });
});

describe('Pag-IBIG (pagibigShares)', () => {
  it.each([
    [1500, 15, 30],
    [8000, 160, 160],
    [30000, 200, 200],
  ])('₱%s → employee ₱%s, employer ₱%s', (comp, employee, employer) => {
    const shares = pagibigShares(pesos(comp), SEED_PAGIBIG_CONTRIBUTIONS);
    expect(shares.employeeCentavos).toBe(pesos(employee));
    expect(shares.employerCentavos).toBe(pesos(employer));
  });

  it('refuses a last bracket with a limit, or brackets out of order', () => {
    const { brackets, maxFundSalaryCentavos } = SEED_PAGIBIG_CONTRIBUTIONS;
    expect(
      pagibigContributionsSchema.safeParse({
        brackets: [brackets[1], brackets[0]],
        maxFundSalaryCentavos,
      }).success,
    ).toBe(false);
    expect(
      pagibigContributionsSchema.safeParse({ brackets: [brackets[0]], maxFundSalaryCentavos })
        .success,
    ).toBe(false);
  });
});

describe('BIR semi-monthly withholding (semiMonthlyWithholding)', () => {
  it.each([
    [10417, 0],
    [12000, 237.45],
    [20000, 1604.1],
    [50000, 8437.45],
  ])('₱%s → ₱%s', (taxable, tax) => {
    expect(semiMonthlyWithholding(pesos(taxable), SEED_WITHHOLDING_TAX_SEMI_MONTHLY)).toBe(
      pesos(tax),
    );
  });

  it('has continuous brackets: each base is the previous base plus its rate times the width', () => {
    const { brackets } = SEED_WITHHOLDING_TAX_SEMI_MONTHLY;
    for (let i = 1; i < brackets.length; i += 1) {
      const previous = defined(brackets[i - 1]);
      const bracket = defined(brackets[i]);
      const width = bracket.overCentavos - previous.overCentavos;
      expect(bracket.baseTaxCentavos).toBe(
        previous.baseTaxCentavos + scaleCentavos(width, previous.rate),
      );
    }
  });

  it('refuses a first bracket other than { 0, 0, "0" } and brackets out of order', () => {
    const { brackets } = SEED_WITHHOLDING_TAX_SEMI_MONTHLY;
    expect(withholdingTaxSemiMonthlySchema.safeParse({ brackets: brackets.slice(1) }).success).toBe(
      false,
    );
    expect(
      withholdingTaxSemiMonthlySchema.safeParse({
        brackets: [brackets[0], brackets[2], brackets[1]],
      }).success,
    ).toBe(false);
  });
});

describe('de minimis', () => {
  it('puts the overtime meal limit at 30% of the regional minimum wage: ₱226.50 a day at ₱755', () => {
    const meals = defined(
      SEED_DE_MINIMIS_LIMITS.items.find((item) => item.key === 'overtimeMeals'),
    );
    expect(deMinimisLimitCentavos(meals, pesos(755))).toBe(pesos(226.5));
    const rice = defined(SEED_DE_MINIMIS_LIMITS.items.find((item) => item.key === 'riceSubsidy'));
    expect(deMinimisLimitCentavos(rice, pesos(755))).toBe(pesos(2500));
  });

  it('refuses both an amount and a share, and duplicate keys', () => {
    const [rice] = SEED_DE_MINIMIS_LIMITS.items;
    expect(
      deMinimisLimitsSchema.safeParse({ items: [{ ...rice, rateOfMinimumWage: '0.3' }] }).success,
    ).toBe(false);
    expect(deMinimisLimitsSchema.safeParse({ items: [rice, rice] }).success).toBe(false);
  });
});

describe('cut-offs (cutOffFor, seeded schedule)', () => {
  it('pays 2026-02-11 to 2026-02-25 on 2026-02-28', () => {
    for (const day of ['2026-02-11', '2026-02-18', '2026-02-25']) {
      expect(cutOffFor(day, SEED_PAYROLL_SETTINGS)).toEqual({
        key: 'endOfMonth',
        start: '2026-02-11',
        end: '2026-02-25',
        payDate: '2026-02-28',
      });
    }
  });

  it('pays 2026-01-26 to 2026-02-10 on 2026-02-15', () => {
    for (const day of ['2026-01-26', '2026-01-31', '2026-02-01', '2026-02-10']) {
      expect(cutOffFor(day, SEED_PAYROLL_SETTINGS)).toEqual({
        key: 'midMonth',
        start: '2026-01-26',
        end: '2026-02-10',
        payDate: '2026-02-15',
      });
    }
  });

  it('pays the end-of-month cut-off in February 2028 on the 29th, and a 31-day month on the 30th', () => {
    expect(cutOffFor('2028-02-20', SEED_PAYROLL_SETTINGS).payDate).toBe('2028-02-29');
    expect(cutOffFor('2026-03-20', SEED_PAYROLL_SETTINGS).payDate).toBe('2026-03-30');
    expect(cutOffFor('2026-12-28', SEED_PAYROLL_SETTINGS)).toMatchObject({
      start: '2026-12-26',
      end: '2027-01-10',
      payDate: '2027-01-15',
    });
  });

  it('knows the cut-off start days', () => {
    expect(isCutOffStart('2026-11-26', SEED_PAYROLL_SETTINGS)).toBe(true);
    expect(isCutOffStart('2026-11-11', SEED_PAYROLL_SETTINGS)).toBe(true);
    expect(isCutOffStart('2026-11-01', SEED_PAYROLL_SETTINGS)).toBe(false);
  });

  it('refuses a split that doesn’t total exactly 1, overlapping or gapped cut-offs, and an early pay day', () => {
    const base = SEED_PAYROLL_SETTINGS;
    expect(payrollSettingsSchema.safeParse(base).success).toBe(true);
    expect(
      payrollSettingsSchema.safeParse({
        ...base,
        contributionSplit: {
          ...base.contributionSplit,
          sss: { midMonth: '0.5', endOfMonth: '0.4999' },
        },
      }).success,
    ).toBe(false);
    expect(
      payrollSettingsSchema.safeParse({
        ...base,
        contributionSplit: {
          ...base.contributionSplit,
          pagibig: { midMonth: '0.3', endOfMonth: '0.7' },
        },
      }).success,
    ).toBe(true);
    const overlap = [base.cutOffs[0], { ...defined(base.cutOffs[1]), endDay: 26 }];
    expect(payrollSettingsSchema.safeParse({ ...base, cutOffs: overlap }).success).toBe(false);
    const gap = [base.cutOffs[0], { ...defined(base.cutOffs[1]), startDay: 12 }];
    expect(payrollSettingsSchema.safeParse({ ...base, cutOffs: gap }).success).toBe(false);
    const earlyPay = [{ ...defined(base.cutOffs[0]), payDay: 10 }, base.cutOffs[1]];
    expect(payrollSettingsSchema.safeParse({ ...base, cutOffs: earlyPay }).success).toBe(false);
    expect(payrollSettingsSchema.safeParse({ ...base, cutOffs: [base.cutOffs[0]] }).success).toBe(
      false,
    );
  });

  it('gives the end-of-month cut-off the remainder of a split', () => {
    expect(splitContribution(pesos(1250.01), 'sss', SEED_PAYROLL_SETTINGS)).toEqual({
      midMonth: 62501,
      endOfMonth: 62500,
    });
    const parts = splitContribution(12345, 'philhealth', SEED_PAYROLL_SETTINGS);
    expect(parts.midMonth + parts.endOfMonth).toBe(12345);
  });
});

describe('minimum wage (NCR, factor 261): monthly × 12 < minimum × 261', () => {
  const ncr28 = defined(SEED_MINIMUM_WAGES_NCR_28.regions[0]).dailyRateCentavos;
  const ncr26 = defined(SEED_MINIMUM_WAGES_NCR_26.regions[0]).dailyRateCentavos;

  it('at ₱755', () => {
    expect(ncr28).toBe(75500);
    expect(1642124 * 12).toBe(19705488);
    expect(75500 * 261).toBe(19705500);
    expect(isBelowMinimumWage(1642124, 'monthly', ncr28, 261)).toBe(true);
    expect(isBelowMinimumWage(1642125, 'monthly', ncr28, 261)).toBe(false);
    expect(isBelowMinimumWage(75499, 'daily', ncr28, 261)).toBe(true);
    expect(isBelowMinimumWage(75500, 'daily', ncr28, 261)).toBe(false);
  });

  it('shows ₱16,000.00 monthly as a daily rate of ₱735.63', () => {
    expect(dailyRateCentavos(1600000, 'monthly', 261)).toBe(73563);
    const warning = minimumWageWarningFor({
      amountCentavos: 1600000,
      rateType: 'monthly',
      region: 'NCR',
      wageOrder: 'Wage Order NCR-28',
      minimumDailyRateCentavos: ncr28,
      dailyRateFactor: 261,
      checkedOn: '2026-10-12',
    });
    expect(warning?.message).toBe(
      `The daily rate ${formatPeso(73563)} is below the NCR minimum wage of ${formatPeso(75500)} (Wage Order NCR-28). It will be flagged in payroll.`,
    );
    expect(warning?.message).toContain('₱735.63');
  });

  it('never shows a rate just under the minimum as the minimum itself', () => {
    // ₱16,421.24 a month is ₱754.9995… a day: below ₱755, and shown as ₱754.99, not ₱755.00.
    const warning = minimumWageWarningFor({
      amountCentavos: 1642124,
      rateType: 'monthly',
      region: 'NCR',
      wageOrder: 'Wage Order NCR-28',
      minimumDailyRateCentavos: ncr28,
      dailyRateFactor: 261,
      checkedOn: '2026-10-12',
    });
    expect(warning?.dailyRateCentavos).toBe(75499);
    expect(warning?.message).toBe(
      'The daily rate ₱754.99 is below the NCR minimum wage of ₱755.00 (Wage Order NCR-28). It will be flagged in payroll.',
    );
  });

  it('at ₱695', () => {
    expect(ncr26).toBe(69500);
    expect(isBelowMinimumWage(1511624, 'monthly', ncr26, 261)).toBe(true);
    expect(isBelowMinimumWage(1511625, 'monthly', ncr26, 261)).toBe(false);
    expect(ratio(1511625 * 12, 261)).toEqual(ratio(69500));
  });
});

describe('allowances (pure rule)', () => {
  const internet: AllowanceType = {
    key: 'internet',
    name: 'Internet allowance',
    taxTreatment: 'nonTaxable',
    deMinimisKey: null,
    basis: 'perCutOff',
    defaultAmountCentavos: 50000,
    autoAssign: true,
    active: true,
  };
  const at = (n: number) => new Date(Date.UTC(2026, 10, 1, 0, 0, n));

  it('applies an automatic type from the date hired, never before', () => {
    const resolve = (day: string) =>
      resolveAllowances({ day, dateHired: '2026-11-03', types: [internet], entries: [] });
    expect(resolve('2026-11-02')).toEqual([]);
    expect(resolve('2026-11-03')).toEqual([
      expect.objectContaining({
        typeKey: 'internet',
        origin: 'automatic',
        amountCentavos: 50000,
        since: '2026-11-03',
      }),
    ]);
  });

  it('lets the latest entry win, the newest on a tie; end stops it', () => {
    const entries = [
      {
        id: 'a',
        typeKey: 'internet',
        effectiveDate: '2026-12-01',
        kind: 'set' as const,
        createdAt: at(1),
        amountCentavos: 70000,
      },
      {
        id: 'b',
        typeKey: 'internet',
        effectiveDate: '2026-12-01',
        kind: 'set' as const,
        createdAt: at(2),
        amountCentavos: 80000,
      },
      {
        id: 'c',
        typeKey: 'internet',
        effectiveDate: '2027-01-01',
        kind: 'end' as const,
        createdAt: at(3),
      },
    ];
    const resolve = (day: string) =>
      resolveAllowances({ day, dateHired: '2026-11-03', types: [internet], entries });
    expect(resolve('2026-11-30')[0]).toMatchObject({ origin: 'automatic', amountCentavos: 50000 });
    expect(resolve('2026-12-01')[0]).toMatchObject({
      origin: 'assigned',
      amountCentavos: 80000,
      entryId: 'b',
    });
    expect(resolve('2027-01-01')).toEqual([]);
  });

  it('checks allowance types: de minimis names its limit, automatic only per cut-off, keys stay', () => {
    expect(allowanceTypeSchema.safeParse(internet).success).toBe(true);
    expect(allowanceTypeSchema.safeParse({ ...internet, taxTreatment: 'deMinimis' }).success).toBe(
      false,
    );
    expect(
      allowanceTypeSchema.safeParse({
        ...internet,
        taxTreatment: 'deMinimis',
        deMinimisKey: 'riceSubsidy',
      }).success,
    ).toBe(true);
    expect(allowanceTypeSchema.safeParse({ ...internet, basis: 'perDayPresent' }).success).toBe(
      false,
    );
    expect(allowanceTypesSchema.safeParse({ types: [internet, internet] }).success).toBe(false);
    expect(removedAllowanceTypeKeys({ types: [internet] }, { types: [] })).toEqual(['internet']);
    expect(
      removedAllowanceTypeKeys({ types: [internet] }, { types: [{ ...internet, active: false }] }),
    ).toEqual([]);
  });

  it('parses the "Assign allowance" form in pesos, with no amount for an end', () => {
    const base = {
      employeeId: '0123456789abcdef01234567',
      typeKey: 'internet',
      effectiveDate: '2026-12-01',
      reason: 'Made up',
    };
    expect(
      allowanceAssignmentFormSchema.parse({ ...base, kind: 'set', amount: '₱750.50' })
        .amountCentavos,
    ).toBe(75050);
    expect(
      allowanceAssignmentFormSchema.parse({ ...base, kind: 'end', amount: '5' }).amountCentavos,
    ).toBeNull();
    expect(
      allowanceAssignmentFormSchema.safeParse({ ...base, kind: 'set', amount: '0' }).success,
    ).toBe(false);
    expect(allowanceAssignmentFormSchema.safeParse({ ...base, kind: 'set' }).success).toBe(false);
  });
});
