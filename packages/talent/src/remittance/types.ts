import type { BusinessDate, Centavos } from '@pulse/core';
import type { Sex } from '../fixed-sets';
import type {
  PagibigContributions,
  PhilhealthContributions,
  SssContributions,
} from '../payroll/schemas';
import type { PayrollBreakdown } from '../payroll-run/types';
import type { RemittanceAgency, RemittanceMonth } from './agencies';

// Spec: docs/modules/talent.md#employer-contributions-and-remittances-build-step-211 ("What each
// report holds", "The BIR 1601-C data"; decisions 379–382 and 385 in docs/BUILD_PLAN.md) and
// docs/DATA_MODEL.md#collection-ownership (`remittanceReports.rows` and `totals`) — the report
// builder's inputs and the snapshot it produces. Every amount is a whole number of centavos.
//
// The snapshot's rows and totals are stored encrypted as one JSON string each (category
// `payslip`), with `rowsVersion` 1; the rows hold every employee's government ID number in full.

/** The rows' JSON shape. A later shape gets a new number and a reader for the old one. */
export const REMITTANCE_ROWS_VERSION = 1;

// ---------------------------------------------------------------------------------------------
// Inputs

/** A source run: a finalized regular run of the month, with the tables it stored. */
export interface RemittanceSourceRun {
  runId: string;
  number: string;
  periodStart: BusinessDate;
  periodEnd: BusinessDate;
  payDate: BusinessDate;
  /**
   * The contribution tables in the versions the run stored (`settingVersions`), or null when the
   * version can't be found (the row then splits regular SS first and is checked against nothing).
   */
  tables: {
    sss: SssContributions | null;
    philhealth: PhilhealthContributions | null;
    pagibig: PagibigContributions | null;
  };
}

/** One employee's line in a source run, its breakdown decrypted. */
export interface RemittanceSourceLine {
  runId: string;
  employeeId: string;
  breakdown: PayrollBreakdown;
}

/** One employee's identity and IDs today (Core's identity, step 2.1's record, step 2.6's facts). */
export interface RemittanceEmployee {
  employeeId: string;
  employeeNumber: string;
  firstName: string;
  middleName: string | null;
  lastName: string;
  dateHired: BusinessDate;
  separationDate: BusinessDate | null;
  dateOfBirth: BusinessDate | null;
  sex: Sex | null;
  /** The decrypted government IDs, null when not on file. */
  ids: {
    sss: string | null;
    philhealth: string | null;
    pagibig: string | null;
    tin: string | null;
  };
  /** Step 2.6: true when HR verified the government IDs. */
  idsVerified: boolean;
}

// ---------------------------------------------------------------------------------------------
// The snapshot

/** A share split into regular SS and MPF (PhilHealth, Pag-IBIG and BIR: all regular, MPF 0). */
export interface RemittanceShare {
  totalCentavos: Centavos;
  regularCentavos: Centavos;
  mpfCentavos: Centavos;
}

/** An employee's BIR Form 1601-C figures for the month (decision 382). */
export interface Bir1601cFigures {
  /** Item 14: total compensation. */
  totalCompensationCentavos: Centavos;
  /** Item 15: a minimum wage earner's statutory minimum wage. */
  statutoryMinimumWageCentavos: Centavos;
  /** Item 16: a minimum wage earner's holiday pay, overtime, night differential and hazard pay. */
  mweHolidayOvertimeCentavos: Centavos;
  /** Item 17: 13th month pay and other benefits (0 in step 2.11). */
  thirteenthMonthCentavos: Centavos;
  /** Item 18: de minimis benefits. */
  deMinimisCentavos: Centavos;
  /** Item 19: the employee's SSS, PhilHealth and Pag-IBIG shares. */
  mandatoryContributionsCentavos: Centavos;
  /** Item 20: other non-taxable compensation. */
  otherNonTaxableCentavos: Centavos;
  /** Item 21: total non-taxable compensation (15 to 20). */
  nonTaxableCentavos: Centavos;
  /** Item 22: total taxable compensation (14 − 21). */
  taxableCentavos: Centavos;
  /** Item 23: taxable compensation not subject to withholding tax. */
  taxableNotWithheldCentavos: Centavos;
  /** Item 25: tax withheld. */
  taxWithheldCentavos: Centavos;
  /** The lines' own stored taxable compensation, for the item 22 check. */
  runsTaxableCentavos: Centavos;
}

/** The BIR 1601-C items for the month, summed over the rows (decision 382). */
export interface Bir1601cItems {
  item14: Centavos;
  item15: Centavos;
  item16: Centavos;
  item17: Centavos;
  item18: Centavos;
  item19: Centavos;
  item20: Centavos;
  item21: Centavos;
  item22: Centavos;
  item23: Centavos;
  item24: Centavos;
  item25: Centavos;
  /** The sum of the lines' stored taxable compensation. */
  runsTaxableCentavos: Centavos;
  /** Item 22 less the runs' taxable compensation ("Item 22 differs … by ₱X" when not 0). */
  item22DifferenceCentavos: Centavos;
}

export interface RemittanceRowFlags {
  /** The month's totals aren't the table's shares for its salary credit or basis. */
  differsFromSchedule: boolean;
  /** No ID on file. */
  missingId: boolean;
  /** An ID on file that HR hasn't verified (step 2.6). */
  unverifiedId: boolean;
}

/** New hire or separated in the month. */
export type RemittanceRowStatus = 'newHire' | 'separated';

/** One employee's row (one per employee with a line in any source run). */
export interface RemittanceRow {
  employeeId: string;
  employeeNumber: string;
  lastName: string;
  firstName: string;
  middleName: string | null;
  /** The agency's ID in full (digits as stored), or null. Shown masked on the page. */
  idNumber: string | null;
  /** PhilHealth only: the date of birth and sex (else null). */
  dateOfBirth: BusinessDate | null;
  sex: Sex | null;
  status: RemittanceRowStatus | null;
  /** The date hired or separation date for `status`, or null. */
  statusDate: BusinessDate | null;
  /** True when the employee's latest source line is a minimum wage earner's. */
  minimumWageEarner: boolean;
  /**
   * SSS: the monthly salary credit; PhilHealth: the monthly basic salary (its basis); Pag-IBIG:
   * the monthly compensation (its basis); BIR: 0. From the latest source line.
   */
  basisCentavos: Centavos;
  employee: RemittanceShare;
  employer: RemittanceShare;
  /** SSS only: EC (else 0). */
  ecCentavos: Centavos;
  /** SSS: employee + employer + EC; PhilHealth and Pag-IBIG: employee + employer; BIR: tax. */
  totalCentavos: Centavos;
  /** BIR 1601-C only (else null). */
  bir: Bir1601cFigures | null;
  flags: RemittanceRowFlags;
}

/** The rows as stored (one encrypted JSON string). */
export interface RemittanceRowsDocument {
  rowsVersion: typeof REMITTANCE_ROWS_VERSION;
  rows: RemittanceRow[];
}

/** A report's totals (one encrypted JSON string). */
export interface RemittanceTotals {
  employeeCount: number;
  employee: RemittanceShare;
  employer: RemittanceShare;
  ecCentavos: Centavos;
  totalCentavos: Centavos;
  /** SSS: employee + employer + EC; PhilHealth and Pag-IBIG: employee + employer; BIR: tax. */
  amountDueCentavos: Centavos;
  /** BIR 1601-C only (else null). */
  bir: Bir1601cItems | null;
}

/** The plain flag counts kept beside the encrypted rows. */
export interface RemittanceFlagCounts {
  differsFromSchedule: number;
  missingId: number;
  unverifiedId: number;
}

/** The employer's details as they were when generated (company data, plain). */
export interface RemittanceEmployerDetails {
  registeredName: string;
  businessAddress: string;
  tin: string;
  rdoCode: string;
  /** The agency's employer number (for BIR, the TIN). */
  employerNumber: string;
  /** True while the employer number (or the TIN for BIR) is a placeholder. */
  placeholder: boolean;
}

/** What the exports and the upload formats render from. */
export interface RemittanceSnapshot {
  agency: RemittanceAgency;
  month: RemittanceMonth;
  rows: readonly RemittanceRow[];
  totals: RemittanceTotals;
  employer: RemittanceEmployerDetails;
  dueDate: BusinessDate;
  /** The cut-offs paid before go-live ("Sep 26 – Oct 10, 2026"), or null. */
  goLivePeriods: string | null;
}
