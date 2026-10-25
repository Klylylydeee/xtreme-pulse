import type { RemittanceRow } from '../types';
import type { RemittanceFormatDefinition } from './definition';
import { amountText, asciiText, csvLine, digitsOnly, fileText, slashDate } from './text';

// Spec: docs/modules/talent.md#employer-contributions-and-remittances-build-step-211 ("The first
// definitions": `philhealth.rf1.assumed-2026-10`; decision 388, HANDOFF item 379) — the PhilHealth
// RF-1 employer remittance report for EPRS, as comma-separated text. ASSUMED from PhilHealth's
// public description of the RF-1 and EPRS; NOT checked against PhilHealth's official file
// specification (`verified: false`), so the export warns HR.
//
// Lines, each ended with CR LF:
// - The employer line: PhilHealth employer number, registered name, TIN, address, applicable
//   period (`MM/YYYY`).
// - The header line, then one line per row: PhilHealth PIN, last name, first name, middle name,
//   date of birth, sex (`M`/`F`), monthly basic salary, PS, ES, status (`NE` new hire, `S`
//   separated, blank), status date.
// - The last line: `TOTAL`, the count, total PS, total ES.

const STATUS_CODES: Record<NonNullable<RemittanceRow['status']>, string> = {
  newHire: 'NE',
  separated: 'S',
};

const HEADER = [
  'PIN',
  'LAST NAME',
  'FIRST NAME',
  'MIDDLE NAME',
  'DATE OF BIRTH',
  'SEX',
  'MONTHLY BASIC SALARY',
  'PS',
  'ES',
  'STATUS',
  'STATUS DATE',
];

export const PHILHEALTH_RF1_ASSUMED_2026_10: RemittanceFormatDefinition = {
  id: 'philhealth.rf1.assumed-2026-10',
  agency: 'philhealth',
  label: 'PhilHealth RF-1 employer remittance report (CSV)',
  contentType: 'text/csv',
  extension: 'csv',
  verified: false,
  source:
    'Assumed from PhilHealth’s public description of the RF-1 report and the Electronic Premium Remittance System (searched 2026-10-25); no official field layout was found.',
  build(snapshot) {
    const { employer, month } = snapshot;
    const first = csvLine([
      digitsOnly(employer.employerNumber),
      asciiText(employer.registeredName),
      digitsOnly(employer.tin),
      asciiText(employer.businessAddress),
      `${month.slice(5, 7)}/${month.slice(0, 4)}`,
    ]);
    const rows = snapshot.rows.map((row) =>
      csvLine([
        digitsOnly(row.idNumber),
        asciiText(row.lastName),
        asciiText(row.firstName),
        asciiText(row.middleName),
        slashDate(row.dateOfBirth),
        row.sex === 'male' ? 'M' : row.sex === 'female' ? 'F' : '',
        amountText(row.basisCentavos),
        amountText(row.employee.totalCentavos),
        amountText(row.employer.totalCentavos),
        row.status ? STATUS_CODES[row.status] : '',
        row.status ? slashDate(row.statusDate) : '',
      ]),
    );
    const last = csvLine([
      'TOTAL',
      String(snapshot.rows.length),
      amountText(snapshot.totals.employee.totalCentavos),
      amountText(snapshot.totals.employer.totalCentavos),
    ]);
    return fileText([first, csvLine(HEADER), ...rows, last]);
  },
};
