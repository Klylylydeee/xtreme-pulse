import {
  allocateCentavos,
  assertCentavos,
  type BusinessDate,
  type Centavos,
  isBusinessDate,
  type Ratio,
  ratio,
  scaleCentavos,
} from '@pulse/core';
import type { RateType } from '../fixed-sets';
import type {
  ContributionAgency,
  CutOff,
  CutOffKey,
  DeMinimisItem,
  PagibigContributions,
  PayrollSettings,
  PhilhealthContributions,
  SssContributions,
  WithholdingTaxSemiMonthly,
} from './schemas';

// Spec: docs/modules/talent.md#payroll-settings-and-allowances-build-step-23 (decisions 200, 206
// and 209 in docs/BUILD_PLAN.md) — pure table lookups for the tests and later steps. No pay is
// computed here: each lookup reads one table for one amount, exactly, with integer centavos and
// exact ratios, and rounds once (half-up) where it gives an amount.

// ---------------------------------------------------------------------------------------------
// Dates

function partsOf(day: BusinessDate): { year: number; month: number; date: number } {
  if (!isBusinessDate(day)) throw new RangeError(`"${day}" is not a date in YYYY-MM-DD form.`);
  return {
    year: Number(day.slice(0, 4)),
    month: Number(day.slice(5, 7)),
    date: Number(day.slice(8)),
  };
}

/** The number of days in a month (1–12). */
export function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function dayOf(year: number, month: number, date: number): BusinessDate {
  // Normalize month overflow (13 → January next year, 0 → December last year).
  const normalized = new Date(Date.UTC(year, month - 1, 1));
  const y = normalized.getUTCFullYear();
  const m = normalized.getUTCMonth() + 1;
  const d = Math.min(date, daysInMonth(y, m));
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

// ---------------------------------------------------------------------------------------------
// Cut-offs

export interface CutOffPeriod {
  key: CutOffKey;
  /** The first day of the cut-off. */
  start: BusinessDate;
  /** The last day of the cut-off. */
  end: BusinessDate;
  /** The pay date: the pay day in the month the cut-off ends, moved to the month's last day. */
  payDate: BusinessDate;
}

function wraps(cutOff: CutOff): boolean {
  return cutOff.startDay > cutOff.endDay;
}

function covers(cutOff: CutOff, date: number): boolean {
  if (!wraps(cutOff))
    return date >= cutOff.startDay && (date <= cutOff.endDay || cutOff.endDay === 28);
  return date >= cutOff.startDay || date <= cutOff.endDay;
}

/**
 * The cut-off `day` falls in, with its start, end and pay date. A cut-off that wraps (26th to
 * 10th) runs into the next month; one ending on day 28 runs to the month's last day. Pay dates
 * never move for weekends or holidays (*assumption, to be confirmed by HR*).
 */
export function cutOffFor(
  day: BusinessDate,
  settings: Pick<PayrollSettings, 'cutOffs'>,
): CutOffPeriod {
  const { year, month, date } = partsOf(day);
  const cutOff = settings.cutOffs.find((candidate) => covers(candidate, date));
  if (!cutOff) throw new RangeError(`No cut-off covers ${day}. Check the pay schedule.`);
  let startMonth = month;
  let endMonth = month;
  if (wraps(cutOff)) {
    if (date >= cutOff.startDay) endMonth = month + 1;
    else startMonth = month - 1;
  }
  const start = dayOf(year, startMonth, cutOff.startDay);
  const endDay = !wraps(cutOff) && cutOff.endDay === 28 ? 31 : cutOff.endDay;
  const end = dayOf(year, endMonth, endDay);
  const endParts = partsOf(end);
  return {
    key: cutOff.key,
    start,
    end,
    payDate: dayOf(endParts.year, endParts.month, cutOff.payDay),
  };
}

/** True when `day` is the start day of one of the schedule's cut-offs. */
export function isCutOffStart(
  day: BusinessDate,
  settings: Pick<PayrollSettings, 'cutOffs'>,
): boolean {
  const { date } = partsOf(day);
  return settings.cutOffs.some((cutOff) => cutOff.startDay === date);
}

/**
 * Splits a month's share across the two cut-offs by the agency's split. The end-of-month cut-off
 * takes the remainder, so the two parts always add up to the share.
 */
export function splitContribution(
  monthlyCentavos: Centavos,
  agency: ContributionAgency,
  settings: Pick<PayrollSettings, 'contributionSplit'>,
): Record<CutOffKey, Centavos> {
  const split = settings.contributionSplit[agency];
  const [midMonth = 0, endOfMonth = 0] = allocateCentavos(monthlyCentavos, [
    split.midMonth,
    split.endOfMonth,
  ]);
  return { midMonth, endOfMonth };
}

// ---------------------------------------------------------------------------------------------
// SSS

export interface SssShares {
  /** The monthly salary credit: regular SS + MPF. */
  mscCentavos: Centavos;
  regularMscCentavos: Centavos;
  mpfMscCentavos: Centavos;
  employee: { regularCentavos: Centavos; mpfCentavos: Centavos; totalCentavos: Centavos };
  employer: { regularCentavos: Centavos; mpfCentavos: Centavos; totalCentavos: Centavos };
  ecCentavos: Centavos;
}

/** The SSS row for a month's compensation: the last row starting at or below it. */
export function sssRowFor(compensationCentavos: Centavos, table: SssContributions): SssShares {
  const amount = assertCentavos(compensationCentavos, 'compensation');
  let found = table.rows[0];
  for (const row of table.rows) {
    if (row.minCompensationCentavos <= amount) found = row;
    else break;
  }
  if (!found) throw new RangeError('The SSS table has no rows.');
  return {
    mscCentavos: found.regularMscCentavos + found.mpfMscCentavos,
    regularMscCentavos: found.regularMscCentavos,
    mpfMscCentavos: found.mpfMscCentavos,
    employee: {
      ...found.employee,
      totalCentavos: found.employee.regularCentavos + found.employee.mpfCentavos,
    },
    employer: {
      ...found.employer,
      totalCentavos: found.employer.regularCentavos + found.employer.mpfCentavos,
    },
    ecCentavos: found.ecCentavos,
  };
}

// ---------------------------------------------------------------------------------------------
// PhilHealth and Pag-IBIG

export interface ContributionShares {
  /** The compensation the rates apply to, after the floor, ceiling or maximum. */
  basisCentavos: Centavos;
  premiumCentavos: Centavos;
  employeeCentavos: Centavos;
  employerCentavos: Centavos;
}

/**
 * PhilHealth for a month: the premium on the basis (between the floor and ceiling), rounded once,
 * then split by the employee's share; the employer takes the remainder.
 */
export function philhealthShares(
  monthlyBasicCentavos: Centavos,
  settings: PhilhealthContributions,
): ContributionShares {
  const amount = assertCentavos(monthlyBasicCentavos, 'monthly basic salary');
  const basis = Math.min(Math.max(amount, settings.floorCentavos), settings.ceilingCentavos);
  const premium = scaleCentavos(basis, settings.premiumRate);
  const share = ratio(settings.employeeShare);
  const rest = ratio(share.denominator - share.numerator, share.denominator);
  const [employee = 0, employer = 0] =
    share.numerator === 0n
      ? [0, premium]
      : rest.numerator === 0n
        ? [premium, 0]
        : allocateCentavos(premium, [share, rest]);
  return {
    basisCentavos: basis,
    premiumCentavos: premium,
    employeeCentavos: employee,
    employerCentavos: employer,
  };
}

/**
 * Pag-IBIG for a month: the bracket by the compensation (an upper limit is inclusive), each rate
 * on the compensation up to the maximum fund salary.
 */
export function pagibigShares(
  monthlyCompensationCentavos: Centavos,
  settings: PagibigContributions,
): ContributionShares {
  const amount = assertCentavos(monthlyCompensationCentavos, 'monthly compensation');
  const bracket =
    settings.brackets.find((b) => b.upToCentavos === null || amount <= b.upToCentavos) ??
    settings.brackets[settings.brackets.length - 1];
  if (!bracket) throw new RangeError('The Pag-IBIG table has no brackets.');
  const basis = Math.min(amount, settings.maxFundSalaryCentavos);
  const employee = scaleCentavos(basis, bracket.employeeRate);
  const employer = scaleCentavos(basis, bracket.employerRate);
  return {
    basisCentavos: basis,
    premiumCentavos: employee + employer,
    employeeCentavos: employee,
    employerCentavos: employer,
  };
}

// ---------------------------------------------------------------------------------------------
// BIR

/**
 * The semi-monthly withholding tax on a cut-off's taxable compensation: the bracket it is over,
 * its base tax plus its rate on the excess, rounded once. At or below the first bracket's start
 * it is nil.
 */
export function semiMonthlyWithholding(
  taxableCentavos: Centavos,
  table: WithholdingTaxSemiMonthly,
): Centavos {
  const amount = assertCentavos(taxableCentavos, 'taxable compensation');
  let bracket = table.brackets[0];
  for (const candidate of table.brackets) {
    if (amount > candidate.overCentavos) bracket = candidate;
    else break;
  }
  if (!bracket || amount <= 0) return 0;
  if (amount <= bracket.overCentavos) return bracket.baseTaxCentavos;
  return bracket.baseTaxCentavos + scaleCentavos(amount - bracket.overCentavos, bracket.rate);
}

// ---------------------------------------------------------------------------------------------
// De minimis

/** A de minimis benefit's limit in centavos: its amount, or its share of the daily minimum wage. */
export function deMinimisLimitCentavos(
  item: DeMinimisItem,
  minimumWageDailyCentavos: Centavos,
): Centavos {
  if (item.limitCentavos !== null) return item.limitCentavos;
  return scaleCentavos(minimumWageDailyCentavos, item.rateOfMinimumWage ?? '0');
}

// ---------------------------------------------------------------------------------------------
// Daily rate and the minimum wage

/**
 * The exact daily rate of a salary, in centavos, as a ratio: a daily-rated amount is the daily
 * rate; a monthly-rated amount is monthly × 12 ÷ the daily rate factor.
 */
export function dailyRateRatio(
  amountCentavos: Centavos,
  rateType: RateType,
  dailyRateFactor: number,
): Ratio {
  const amount = BigInt(assertCentavos(amountCentavos, 'salary'));
  if (rateType === 'daily') return ratio(amount);
  if (!Number.isSafeInteger(dailyRateFactor) || dailyRateFactor <= 0) {
    throw new RangeError('The daily rate factor must be a whole number above zero.');
  }
  return ratio(amount * 12n, dailyRateFactor);
}

/** The daily rate for display, rounded half-up to the centavo (₱16,000.00 monthly → ₱735.63). */
export function dailyRateCentavos(
  amountCentavos: Centavos,
  rateType: RateType,
  dailyRateFactor: number,
): Centavos {
  if (rateType === 'daily') return assertCentavos(amountCentavos, 'salary');
  return scaleCentavos(amountCentavos, ratio(12, dailyRateFactor));
}

/**
 * True when the salary's daily rate is below the daily minimum wage, compared exactly with no
 * rounding: a daily rate directly, a monthly salary as monthly × 12 < minimum × factor.
 */
export function isBelowMinimumWage(
  amountCentavos: Centavos,
  rateType: RateType,
  minimumDailyCentavos: Centavos,
  dailyRateFactor: number,
): boolean {
  const daily = dailyRateRatio(amountCentavos, rateType, dailyRateFactor);
  const minimum = BigInt(assertCentavos(minimumDailyCentavos, 'minimum wage'));
  return daily.numerator < minimum * daily.denominator;
}
