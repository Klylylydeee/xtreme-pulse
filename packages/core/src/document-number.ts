// Spec: docs/DATA_MODEL.md#document-numbers — business documents are numbered
// `PREFIX-YYYY-NNNN` (for example `QT-2026-0012`) from atomic per-prefix, per-year counters.
// The counter itself is in @pulse/core/server (nextDocumentNumber); this file only formats and
// parses.
// Each module passes its own prefix. Where the spec makes the series a setting (the invoice
// series), the module reads the prefix from that setting.

/** A prefix: 2 to 10 capital letters or digits, starting with a letter (`QT`, `PO`, `COE`). */
export const DOCUMENT_PREFIX_PATTERN = /^[A-Z][A-Z0-9]{1,9}$/;

/** At least 4 digits; a series that passes 9,999 in a year simply gets a 5th digit. */
const SEQUENCE_DIGITS = 4;

const DOCUMENT_NUMBER = /^([A-Z][A-Z0-9]{1,9})-(\d{4})-(\d{4,})$/;

export interface DocumentNumberParts {
  prefix: string;
  year: number;
  sequence: number;
}

/** Throws unless `prefix` is a valid document number prefix. */
export function assertDocumentPrefix(prefix: string): string {
  if (!DOCUMENT_PREFIX_PATTERN.test(prefix)) {
    throw new RangeError(
      `"${prefix}" is not a document number prefix. Use 2 to 10 capital letters or digits, starting with a letter.`,
    );
  }
  return prefix;
}

/** `("QT", 2026, 12)` → `"QT-2026-0012"`. */
export function formatDocumentNumber({ prefix, year, sequence }: DocumentNumberParts): string {
  assertDocumentPrefix(prefix);
  if (!Number.isInteger(year) || year < 1000 || year > 9999) {
    throw new RangeError(`${year} is not a 4-digit year.`);
  }
  if (!Number.isSafeInteger(sequence) || sequence < 1) {
    throw new RangeError('A document number sequence starts at 1.');
  }
  return `${prefix}-${year}-${String(sequence).padStart(SEQUENCE_DIGITS, '0')}`;
}

/** `"QT-2026-0012"` → `{ prefix: "QT", year: 2026, sequence: 12 }`, or null if it isn't one. */
export function parseDocumentNumber(value: string): DocumentNumberParts | null {
  const match = DOCUMENT_NUMBER.exec(value.trim());
  if (!match) return null;
  const [, prefix = '', year = '', digits = ''] = match;
  const sequence = Number(digits);
  // Reject "0000" and zero-padding beyond 4 digits, so each number has one spelling.
  if (sequence < 1 || !Number.isSafeInteger(sequence)) return null;
  if (digits.length > SEQUENCE_DIGITS && digits.startsWith('0')) return null;
  return { prefix, year: Number(year), sequence };
}
