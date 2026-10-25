import type { RemittanceRow } from '../types';
import type { RemittanceFormatDefinition } from './definition';
import {
  amountText,
  asciiText,
  compactDate,
  countField,
  digitsOnly,
  fileText,
  leftField,
  rightField,
} from './text';

// Spec: docs/modules/talent.md#employer-contributions-and-remittances-build-step-211 ("The first
// definitions": `sss.r3.assumed-2026-10`; decision 388, HANDOFF item 378) — the SSS electronic
// contribution collection list (R-3) for My.SSS, as fixed-width text. ASSUMED from SSS's public
// description of the R-3 and the R3 File Generator; NOT checked against SSS's official file
// specification (`verified: false`), so the export warns HR.
//
// Records, each ended with CR LF:
// - Header `00`: employer SSS number (10), registered name (40), applicable month (`MMYYYY`).
// - One detail `20` per row: SS number (10), last name (20), first name (20), middle initial (1),
//   regular SS employee + employer (10, right-aligned), EC (8), MPF employee + employer (10),
//   status (`N` new hire, `S` separated, blank) and status date (`MMDDYYYY` or blank).
// - Trailer `99`: the row count (6), then the three totals (12 each).

const STATUS_CODES: Record<NonNullable<RemittanceRow['status']>, string> = {
  newHire: 'N',
  separated: 'S',
};

export const SSS_R3_ASSUMED_2026_10: RemittanceFormatDefinition = {
  id: 'sss.r3.assumed-2026-10',
  agency: 'sss',
  label: 'SSS R-3 contribution collection list (fixed-width text)',
  contentType: 'text/plain',
  extension: 'txt',
  verified: false,
  source:
    'Assumed from SSS’s public description of the R-3 collection list and the R3 File Generator for My.SSS (searched 2026-10-25); no official field layout was found.',
  build(snapshot) {
    const month = snapshot.month;
    const header = [
      '00',
      leftField(digitsOnly(snapshot.employer.employerNumber), 10),
      leftField(asciiText(snapshot.employer.registeredName), 40),
      `${month.slice(5, 7)}${month.slice(0, 4)}`,
    ].join('');
    let regular = 0;
    let ec = 0;
    let mpf = 0;
    const details = snapshot.rows.map((row) => {
      const rowRegular = row.employee.regularCentavos + row.employer.regularCentavos;
      const rowMpf = row.employee.mpfCentavos + row.employer.mpfCentavos;
      regular += rowRegular;
      ec += row.ecCentavos;
      mpf += rowMpf;
      return [
        '20',
        leftField(digitsOnly(row.idNumber), 10),
        leftField(asciiText(row.lastName), 20),
        leftField(asciiText(row.firstName), 20),
        leftField(asciiText(row.middleName).slice(0, 1), 1),
        rightField(amountText(rowRegular), 10, 'regular SS'),
        rightField(amountText(row.ecCentavos), 8, 'EC'),
        rightField(amountText(rowMpf), 10, 'MPF'),
        leftField(row.status ? STATUS_CODES[row.status] : '', 1),
        leftField(row.status ? compactDate(row.statusDate) : '', 8),
      ].join('');
    });
    const trailer = [
      '99',
      countField(snapshot.rows.length, 6, 'row count'),
      rightField(amountText(regular), 12, 'regular SS total'),
      rightField(amountText(ec), 12, 'EC total'),
      rightField(amountText(mpf), 12, 'MPF total'),
    ].join('');
    return fileText([header, ...details, trailer]);
  },
};
