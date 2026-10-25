import type { RemittanceFormatDefinition } from './definition';
import { amountText, asciiText, csvLine, digitsOnly, fileText, slashDate } from './text';

// Spec: docs/modules/talent.md#employer-contributions-and-remittances-build-step-211 ("The first
// definitions": `pagibig.mcrf.assumed-2026-10`; decision 388, HANDOFF item 380) — the Pag-IBIG
// membership contribution remittance form (MCRF) for eSRS, as comma-separated text. ASSUMED from
// Pag-IBIG's public description of the MCRF and eSRS (HDMF Circular No. 499-2026); NOT checked
// against Pag-IBIG's official file specification (`verified: false`), so the export warns HR.
//
// Lines, each ended with CR LF:
// - The employer line: Pag-IBIG employer ID, registered name, address, period (`YYYYMM`).
// - The header line, then one line per row: Pag-IBIG MID, last name, first name, middle name,
//   monthly compensation, employee share, employer share, total, remarks (`NEW`,
//   `SEPARATED MM/DD/YYYY`, blank).

const HEADER = [
  'MID',
  'LAST NAME',
  'FIRST NAME',
  'MIDDLE NAME',
  'MONTHLY COMPENSATION',
  'EE SHARE',
  'ER SHARE',
  'TOTAL',
  'REMARKS',
];

export const PAGIBIG_MCRF_ASSUMED_2026_10: RemittanceFormatDefinition = {
  id: 'pagibig.mcrf.assumed-2026-10',
  agency: 'pagibig',
  label: 'Pag-IBIG membership contribution remittance form (CSV)',
  contentType: 'text/csv',
  extension: 'csv',
  verified: false,
  source:
    'Assumed from Pag-IBIG’s public description of the MCRF and the eSRS made mandatory by HDMF Circular No. 499-2026 (searched 2026-10-25); no official field layout was found.',
  build(snapshot) {
    const { employer, month } = snapshot;
    const first = csvLine([
      digitsOnly(employer.employerNumber),
      asciiText(employer.registeredName),
      asciiText(employer.businessAddress),
      `${month.slice(0, 4)}${month.slice(5, 7)}`,
    ]);
    const rows = snapshot.rows.map((row) =>
      csvLine([
        digitsOnly(row.idNumber),
        asciiText(row.lastName),
        asciiText(row.firstName),
        asciiText(row.middleName),
        amountText(row.basisCentavos),
        amountText(row.employee.totalCentavos),
        amountText(row.employer.totalCentavos),
        amountText(row.totalCentavos),
        row.status === 'newHire'
          ? 'NEW'
          : row.status === 'separated'
            ? `SEPARATED ${slashDate(row.statusDate)}`
            : '',
      ]),
    );
    return fileText([first, csvLine(HEADER), ...rows]);
  },
};
