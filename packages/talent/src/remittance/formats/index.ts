import {
  hasRemittanceUpload,
  REMITTANCE_BIR_NO_UPLOAD_TEXT,
  type RemittanceAgency,
  remittanceMissingIdsRefusal,
  remittancePlaceholderRefusal,
  type RemittanceUploadAgency,
} from '../agencies';
import type { RemittanceSnapshot } from '../types';
import type { RemittanceFormatDefinition } from './definition';
import { PAGIBIG_MCRF_ASSUMED_2026_10 } from './pagibig-mcrf';
import { PHILHEALTH_RF1_ASSUMED_2026_10 } from './philhealth-rf1';
import { SSS_R3_ASSUMED_2026_10 } from './sss-r3';

// Spec: docs/modules/talent.md#employer-contributions-and-remittances-build-step-211 ("Upload
// files"; decisions 381, 386 and 388 in docs/BUILD_PLAN.md) — every upload format definition ever
// used (a report stores the id it was built with), the current one per agency, and when an upload
// file is refused. Pure code.

export type { RemittanceFormatDefinition, RemittanceUploadContentType } from './definition';
export {
  amountText,
  asciiText,
  compactDate,
  CRLF,
  csvLine,
  digitsOnly,
  RemittanceFieldWidthError,
  slashDate,
} from './text';
export { SSS_R3_ASSUMED_2026_10, PHILHEALTH_RF1_ASSUMED_2026_10, PAGIBIG_MCRF_ASSUMED_2026_10 };

/** Every definition, kept for the files already built with it. */
export const REMITTANCE_FORMATS: readonly RemittanceFormatDefinition[] = [
  SSS_R3_ASSUMED_2026_10,
  PHILHEALTH_RF1_ASSUMED_2026_10,
  PAGIBIG_MCRF_ASSUMED_2026_10,
];

/** The definition a newly generated report uses, per agency. */
export const CURRENT_REMITTANCE_FORMATS: Readonly<
  Record<RemittanceUploadAgency, RemittanceFormatDefinition>
> = {
  sss: SSS_R3_ASSUMED_2026_10,
  philhealth: PHILHEALTH_RF1_ASSUMED_2026_10,
  pagibig: PAGIBIG_MCRF_ASSUMED_2026_10,
};

/** The current definition's id for `agency`, or null for BIR 1601-C (no upload file). */
export function currentRemittanceFormatId(agency: RemittanceAgency): string | null {
  return hasRemittanceUpload(agency) ? CURRENT_REMITTANCE_FORMATS[agency].id : null;
}

/** The definition with `id`, or null. */
export function remittanceFormatById(id: string | null): RemittanceFormatDefinition | null {
  return REMITTANCE_FORMATS.find((format) => format.id === id) ?? null;
}

/**
 * Why `snapshot`'s upload file can't be built, or null: BIR 1601-C has none; rows with no ID
 * ("Enter the SS numbers of 1 employee first."); a placeholder employer number.
 */
export function remittanceUploadRefusal(snapshot: RemittanceSnapshot): string | null {
  if (!hasRemittanceUpload(snapshot.agency)) return REMITTANCE_BIR_NO_UPLOAD_TEXT;
  const missing = snapshot.rows.filter((row) => row.flags.missingId).length;
  if (missing > 0) return remittanceMissingIdsRefusal(snapshot.agency, missing);
  if (snapshot.employer.placeholder) return remittancePlaceholderRefusal(snapshot.agency);
  return null;
}

/** True when `text` is printable ASCII with every line ended by CR LF (Core checks it too). */
export function isAsciiCrLfText(text: string): boolean {
  if (text.length === 0 || !text.endsWith('\r\n')) return false;
  return text
    .split('\r\n')
    .slice(0, -1)
    .every((line) => /^[\x20-\x7e]*$/.test(line));
}
