import { type Centavos, sumCentavos } from '@pulse/core';
import { pagibigShares, philhealthShares, type SssShares, sssRowFor } from '../payroll/lookups';
import type { SssContributions } from '../payroll/schemas';
import { ATTENDANCE_DEDUCTION_KINDS, type PayrollLineKind } from '../payroll-run/kinds';
import type { PayrollBreakdown, PayrollLine } from '../payroll-run/types';
import { type RemittanceAgency, type RemittanceMonth, monthOfDay } from './agencies';
import type {
  Bir1601cFigures,
  Bir1601cItems,
  RemittanceEmployee,
  RemittanceFlagCounts,
  RemittanceRow,
  RemittanceShare,
  RemittanceSourceLine,
  RemittanceSourceRun,
  RemittanceTotals,
} from './types';

// Spec: docs/modules/talent.md#employer-contributions-and-remittances-build-step-211 ("What each
// report holds", "Regular SS and MPF", "Differs from the schedule", "Missing IDs", "Totals", "The
// BIR 1601-C data"; decisions 379–382 in docs/BUILD_PLAN.md) — one agency's month report, built
// from the source runs' lines as they are stored. Pure code: plain data in, plain data out.
//
// - A report is what the runs hold (decision 379): each row's amounts are the sums of the source
//   lines' kinds, overrides included, never recomputed from the tables. The basis and the salary
//   credit come from the employee's latest source line (the end-of-month line, else the
//   mid-month line's estimate).
// - The SSS employee split is the line's when its total is the line's month share; the employer
//   split is the `talent.sssContributions` row of the month's salary credit in the version the
//   run stored. A total that isn't the row's is split regular SS first, up to the row's regular
//   part, and the rest MPF (*Assumption*, decision 380).
// - "Differs from the schedule" when a row's totals aren't the table's shares for its credit or
//   basis; never blocking. "No <ID> on file" and "<ID> not verified" from the employee's IDs.
// - BIR 1601-C items 14–25 per decision 382 (*Assumption, to be confirmed by the accountant*).

/** The line kinds each agency's amounts sum (decision 379). */
const KINDS = {
  sssEmployee: 'sssEmployee',
  sssEmployer: 'sssEmployer',
  sssEc: 'sssEc',
  philhealthEmployee: 'philhealthEmployee',
  philhealthEmployer: 'philhealthEmployer',
  pagibigEmployee: 'pagibigEmployee',
  pagibigEmployer: 'pagibigEmployer',
  withholdingTax: 'withholdingTax',
} as const satisfies Record<string, PayrollLineKind>;

/** A minimum wage earner's holiday pay, overtime and night differential (item 16). */
const MWE_ITEM_16_KINDS: readonly PayrollLineKind[] = [
  'holidayPay',
  'holidayWork',
  'restDayWork',
  'overtimeOrdinary',
  'restDayHolidayOvertime',
  'nightDifferential',
];

/** The sum of a breakdown's lines of `kind` (overridden amounts are what the line holds). */
export function sumLinesOfKind(breakdown: PayrollBreakdown, kind: PayrollLineKind): Centavos {
  return sumCentavos(
    breakdown.lines.filter((line) => line.kind === kind).map((line) => line.amountCentavos),
  );
}

/** A line's effect on pay: an earning as it is, a deduction negated (settlements are signed). */
function effect(line: PayrollLine): Centavos {
  return line.side === 'deduction' ? -line.amountCentavos : line.amountCentavos;
}

/** One line's BIR 1601-C figures (decision 382). */
export function bir1601cFiguresOfLine(breakdown: PayrollBreakdown): Bir1601cFigures {
  const mwe = breakdown.facts.minimumWageEarner;
  let item14 = 0;
  let item15 = 0;
  let item16 = 0;
  let item18 = 0;
  let item20 = 0;
  for (const line of breakdown.lines) {
    const attendance = ATTENDANCE_DEDUCTION_KINDS.includes(line.kind);
    // Item 14: every earning but reimbursements, less attendance deductions and manual deductions
    // that reduce taxable pay (settlements included, signed).
    if (line.side === 'earning' && line.kind !== 'reimbursement') item14 += line.amountCentavos;
    if (
      line.side === 'deduction' &&
      (attendance || (line.kind === 'manual' && line.manual?.reducesTaxablePay === true))
    ) {
      item14 -= line.amountCentavos;
    }
    if (mwe) {
      if (line.kind === 'basicPay' || attendance) item15 += effect(line);
      if (MWE_ITEM_16_KINDS.includes(line.kind)) item16 += effect(line);
    }
    if (line.kind === 'allowance' && line.side === 'earning') {
      const nonTaxable = line.amountCentavos - line.taxableCentavos;
      if (line.deMinimisKey) item18 += nonTaxable;
      else item20 += nonTaxable;
    }
    if (line.kind === 'manual' && line.side === 'earning' && !line.taxable) {
      item20 += line.amountCentavos - line.taxableCentavos;
    }
  }
  const item19 =
    sumLinesOfKind(breakdown, KINDS.sssEmployee) +
    sumLinesOfKind(breakdown, KINDS.philhealthEmployee) +
    sumLinesOfKind(breakdown, KINDS.pagibigEmployee);
  const item17 = 0;
  const item21 = item15 + item16 + item17 + item18 + item19 + item20;
  const item22 = item14 - item21;
  const tax = sumLinesOfKind(breakdown, KINDS.withholdingTax);
  return {
    totalCompensationCentavos: item14,
    statutoryMinimumWageCentavos: item15,
    mweHolidayOvertimeCentavos: item16,
    thirteenthMonthCentavos: item17,
    deMinimisCentavos: item18,
    mandatoryContributionsCentavos: item19,
    otherNonTaxableCentavos: item20,
    nonTaxableCentavos: item21,
    taxableCentavos: item22,
    // Set on the month's row: it depends on the whole month's withholding.
    taxableNotWithheldCentavos: 0,
    taxWithheldCentavos: tax,
    runsTaxableCentavos: breakdown.taxableCompensationCentavos,
  };
}

const BIR_FIGURE_KEYS = [
  'totalCompensationCentavos',
  'statutoryMinimumWageCentavos',
  'mweHolidayOvertimeCentavos',
  'thirteenthMonthCentavos',
  'deMinimisCentavos',
  'mandatoryContributionsCentavos',
  'otherNonTaxableCentavos',
  'nonTaxableCentavos',
  'taxableCentavos',
  'taxableNotWithheldCentavos',
  'taxWithheldCentavos',
  'runsTaxableCentavos',
] as const satisfies readonly (keyof Bir1601cFigures)[];

function addFigures(a: Bir1601cFigures, b: Bir1601cFigures): Bir1601cFigures {
  return Object.fromEntries(BIR_FIGURE_KEYS.map((key) => [key, a[key] + b[key]])) as Record<
    keyof Bir1601cFigures,
    Centavos
  >;
}

/** The BIR 1601-C items of a month from its rows' figures (decision 382). */
export function bir1601cItemsOf(figures: readonly Bir1601cFigures[]): Bir1601cItems {
  const sum = (key: keyof Bir1601cFigures) => sumCentavos(figures.map((row) => row[key]));
  const item22 = sum('taxableCentavos');
  const item23 = sum('taxableNotWithheldCentavos');
  const runsTaxable = sum('runsTaxableCentavos');
  return {
    item14: sum('totalCompensationCentavos'),
    item15: sum('statutoryMinimumWageCentavos'),
    item16: sum('mweHolidayOvertimeCentavos'),
    item17: sum('thirteenthMonthCentavos'),
    item18: sum('deMinimisCentavos'),
    item19: sum('mandatoryContributionsCentavos'),
    item20: sum('otherNonTaxableCentavos'),
    item21: sum('nonTaxableCentavos'),
    item22,
    item23,
    item24: item22 - item23,
    item25: sum('taxWithheldCentavos'),
    runsTaxableCentavos: runsTaxable,
    item22DifferenceCentavos: item22 - runsTaxable,
  };
}

// ---------------------------------------------------------------------------------------------
// SSS: the regular SS and MPF split

/** The table row whose salary credit is `mscCentavos`, or null. */
export function sssRowOfCredit(
  mscCentavos: Centavos,
  table: SssContributions | null,
): SssShares | null {
  if (!table) return null;
  const row = table.rows.find(
    (candidate) => candidate.regularMscCentavos + candidate.mpfMscCentavos === mscCentavos,
  );
  return row ? sssRowFor(row.minCompensationCentavos, table) : null;
}

/** Splits `total` regular SS first, up to `regularLimit`, and the rest MPF (decision 380). */
export function splitRegularFirst(total: Centavos, regularLimit: Centavos): RemittanceShare {
  if (total <= regularLimit) {
    return { totalCentavos: total, regularCentavos: total, mpfCentavos: 0 };
  }
  return {
    totalCentavos: total,
    regularCentavos: regularLimit,
    mpfCentavos: total - regularLimit,
  };
}

const whole = (total: Centavos): RemittanceShare => ({
  totalCentavos: total,
  regularCentavos: total,
  mpfCentavos: 0,
});

// ---------------------------------------------------------------------------------------------
// The report

export interface BuildRemittanceReportInput {
  agency: RemittanceAgency;
  month: RemittanceMonth;
  /** The month's source runs, in cut-off order. */
  runs: readonly RemittanceSourceRun[];
  /** Every line of the source runs. */
  lines: readonly RemittanceSourceLine[];
  /** The employees with a line, by id. */
  employees: ReadonlyMap<string, RemittanceEmployee>;
}

export interface BuiltRemittanceReport {
  rows: RemittanceRow[];
  totals: RemittanceTotals;
  flagCounts: RemittanceFlagCounts;
}

const ID_OF: Record<RemittanceAgency, keyof RemittanceEmployee['ids']> = {
  sss: 'sss',
  philhealth: 'philhealth',
  pagibig: 'pagibig',
  bir1601c: 'tin',
};

function statusIn(
  employee: RemittanceEmployee,
  month: RemittanceMonth,
): Pick<RemittanceRow, 'status' | 'statusDate'> {
  if (employee.separationDate && monthOfDay(employee.separationDate) === month) {
    return { status: 'separated', statusDate: employee.separationDate };
  }
  if (monthOfDay(employee.dateHired) === month) {
    return { status: 'newHire', statusDate: employee.dateHired };
  }
  return { status: null, statusDate: null };
}

/** "Lastname, Firstname": the rows' order (then the employee number). */
function compareRows(a: RemittanceRow, b: RemittanceRow): number {
  return (
    a.lastName.localeCompare(b.lastName, 'en') ||
    a.firstName.localeCompare(b.firstName, 'en') ||
    a.employeeNumber.localeCompare(b.employeeNumber, 'en')
  );
}

function rowOf(
  input: BuildRemittanceReportInput,
  employee: RemittanceEmployee,
  lines: readonly { run: RemittanceSourceRun; breakdown: PayrollBreakdown }[],
): RemittanceRow {
  const { agency, month } = input;
  const latest = lines[lines.length - 1];
  if (!latest) throw new Error('A remittance row needs at least one source line.');
  const contributions = latest.breakdown.contributions;
  const tables = latest.run.tables;
  const sum = (kind: PayrollLineKind) =>
    sumCentavos(lines.map(({ breakdown }) => sumLinesOfKind(breakdown, kind)));

  let basisCentavos = 0;
  let employeeShare = whole(0);
  let employerShare = whole(0);
  let ecCentavos = 0;
  let differsFromSchedule = false;
  let bir: Bir1601cFigures | null = null;

  switch (agency) {
    case 'sss': {
      basisCentavos = contributions.sss.mscCentavos;
      const employeeTotal = sum(KINDS.sssEmployee);
      const employerTotal = sum(KINDS.sssEmployer);
      ecCentavos = sum(KINDS.sssEc);
      const row = sssRowOfCredit(basisCentavos, tables.sss);
      const lineRegular = contributions.sss.employeeRegularCentavos;
      const lineMpf = contributions.sss.employeeMpfCentavos;
      // The employee's split: the line's when the month total is the line's month share.
      employeeShare =
        employeeTotal === lineRegular + lineMpf
          ? { totalCentavos: employeeTotal, regularCentavos: lineRegular, mpfCentavos: lineMpf }
          : splitRegularFirst(employeeTotal, row?.employee.regularCentavos ?? lineRegular);
      // The employer's split: the table row of the month's salary credit.
      employerShare =
        row && employerTotal === row.employer.totalCentavos
          ? {
              totalCentavos: employerTotal,
              regularCentavos: row.employer.regularCentavos,
              mpfCentavos: row.employer.mpfCentavos,
            }
          : splitRegularFirst(employerTotal, row?.employer.regularCentavos ?? employerTotal);
      differsFromSchedule =
        !row ||
        employeeTotal !== row.employee.totalCentavos ||
        employerTotal !== row.employer.totalCentavos ||
        ecCentavos !== row.ecCentavos;
      break;
    }
    case 'philhealth': {
      basisCentavos = contributions.philhealth.basisCentavos;
      employeeShare = whole(sum(KINDS.philhealthEmployee));
      employerShare = whole(sum(KINDS.philhealthEmployer));
      const shares = tables.philhealth ? philhealthShares(basisCentavos, tables.philhealth) : null;
      differsFromSchedule =
        !shares ||
        employeeShare.totalCentavos !== shares.employeeCentavos ||
        employerShare.totalCentavos !== shares.employerCentavos;
      break;
    }
    case 'pagibig': {
      basisCentavos = contributions.pagibig.basisCentavos;
      employeeShare = whole(sum(KINDS.pagibigEmployee));
      employerShare = whole(sum(KINDS.pagibigEmployer));
      const shares = tables.pagibig ? pagibigShares(basisCentavos, tables.pagibig) : null;
      differsFromSchedule =
        !shares ||
        employeeShare.totalCentavos !== shares.employeeCentavos ||
        employerShare.totalCentavos !== shares.employerCentavos;
      break;
    }
    case 'bir1601c': {
      const figures = lines
        .map(({ breakdown }) => bir1601cFiguresOfLine(breakdown))
        .reduce((a, b) => addFigures(a, b));
      const mwe = latest.breakdown.facts.minimumWageEarner;
      bir = {
        ...figures,
        // Item 23: the taxable compensation of an employee other than a minimum wage earner
        // whose withholding for the month is nil (*Assumption*, decision 382).
        taxableNotWithheldCentavos:
          !mwe && figures.taxWithheldCentavos === 0 ? figures.taxableCentavos : 0,
      };
      break;
    }
  }

  const idNumber = employee.ids[ID_OF[agency]];
  const totalCentavos =
    agency === 'bir1601c'
      ? (bir?.taxWithheldCentavos ?? 0)
      : employeeShare.totalCentavos + employerShare.totalCentavos + ecCentavos;
  return {
    employeeId: employee.employeeId,
    employeeNumber: employee.employeeNumber,
    lastName: employee.lastName,
    firstName: employee.firstName,
    middleName: employee.middleName,
    idNumber,
    dateOfBirth: agency === 'philhealth' ? employee.dateOfBirth : null,
    sex: agency === 'philhealth' ? employee.sex : null,
    ...(agency === 'bir1601c' ? { status: null, statusDate: null } : statusIn(employee, month)),
    minimumWageEarner: latest.breakdown.facts.minimumWageEarner,
    basisCentavos,
    employee: employeeShare,
    employer: employerShare,
    ecCentavos,
    totalCentavos,
    bir,
    flags: {
      differsFromSchedule,
      missingId: idNumber === null,
      unverifiedId: idNumber !== null && !employee.idsVerified,
    },
  };
}

const addShares = (shares: readonly RemittanceShare[]): RemittanceShare => ({
  totalCentavos: sumCentavos(shares.map((share) => share.totalCentavos)),
  regularCentavos: sumCentavos(shares.map((share) => share.regularCentavos)),
  mpfCentavos: sumCentavos(shares.map((share) => share.mpfCentavos)),
});

/** The totals of a report's rows (decision 379). */
export function remittanceTotalsOf(
  agency: RemittanceAgency,
  rows: readonly RemittanceRow[],
): RemittanceTotals {
  const employee = addShares(rows.map((row) => row.employee));
  const employer = addShares(rows.map((row) => row.employer));
  const ecCentavos = sumCentavos(rows.map((row) => row.ecCentavos));
  const bir =
    agency === 'bir1601c'
      ? bir1601cItemsOf(rows.flatMap((row) => (row.bir ? [row.bir] : [])))
      : null;
  const amountDueCentavos =
    agency === 'bir1601c'
      ? (bir?.item25 ?? 0)
      : employee.totalCentavos + employer.totalCentavos + ecCentavos;
  return {
    employeeCount: rows.length,
    employee,
    employer,
    ecCentavos,
    totalCentavos: sumCentavos(rows.map((row) => row.totalCentavos)),
    amountDueCentavos,
    bir,
  };
}

/** The plain flag counts of a report's rows. */
export function remittanceFlagCountsOf(rows: readonly RemittanceRow[]): RemittanceFlagCounts {
  return {
    differsFromSchedule: rows.filter((row) => row.flags.differsFromSchedule).length,
    missingId: rows.filter((row) => row.flags.missingId).length,
    unverifiedId: rows.filter((row) => row.flags.unverifiedId).length,
  };
}

/**
 * Builds `agency`'s report for `month` from the source runs' lines (see the header): one row per
 * employee with a line in any source run, by name. Throws when a line's run or employee is
 * missing from the input (the service loads both).
 */
export function buildRemittanceReport(input: BuildRemittanceReportInput): BuiltRemittanceReport {
  const runOrder = new Map(input.runs.map((run, index) => [run.runId, index]));
  const byEmployee = new Map<string, { run: RemittanceSourceRun; breakdown: PayrollBreakdown }[]>();
  for (const line of input.lines) {
    const index = runOrder.get(line.runId);
    const run = index === undefined ? undefined : input.runs[index];
    if (!run) throw new Error('A source line belongs to a run that isn’t a source run.');
    const list = byEmployee.get(line.employeeId) ?? [];
    list.push({ run, breakdown: line.breakdown });
    byEmployee.set(line.employeeId, list);
  }
  const rows: RemittanceRow[] = [];
  for (const [employeeId, lines] of byEmployee) {
    const employee = input.employees.get(employeeId);
    if (!employee) throw new Error('A source line’s employee is missing.');
    // The latest line last: the cut-off order of the runs.
    lines.sort((a, b) => (runOrder.get(a.run.runId) ?? 0) - (runOrder.get(b.run.runId) ?? 0));
    rows.push(rowOf(input, employee, lines));
  }
  rows.sort(compareRows);
  return {
    rows,
    totals: remittanceTotalsOf(input.agency, rows),
    flagCounts: remittanceFlagCountsOf(rows),
  };
}

/** "••••1234": an ID's last 4 digits for the page (decision 395); null when not on file. */
export function maskedIdText(idNumber: string | null): string | null {
  if (idNumber === null) return null;
  const digits = idNumber.replace(/\D/g, '');
  return `••••${digits.slice(-4)}`;
}
