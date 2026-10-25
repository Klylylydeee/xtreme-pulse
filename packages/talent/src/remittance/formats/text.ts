import { type BusinessDate, type Centavos, centavosToDecimalString } from '@pulse/core';

// Spec: docs/modules/talent.md#employer-contributions-and-remittances-build-step-211 ("The first
// definitions": text is upper-case ASCII with Ñ written as N and other letters without accents,
// lines end in CR LF, amounts are pesos with two decimals and no separators, dates `MM/DD/YYYY`,
// IDs digits only; decision 388) — the shared text rules of the upload format definitions. Pure.

export const CRLF = '\r\n';

/** Upper-case printable ASCII: accents dropped (Ñ → N), anything else non-printable a space. */
export function asciiText(value: string | null | undefined): string {
  return (value ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toUpperCase()
    .replace(/[^\x20-\x7e]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** An ID as digits only (dashes and spaces dropped), or '' when none. */
export function digitsOnly(value: string | null | undefined): string {
  return (value ?? '').replace(/\D/g, '');
}

/** Pesos with two decimals and no separators: `125000` → `1250.00`, `-5` → `-0.05`. */
export function amountText(centavos: Centavos): string {
  return centavosToDecimalString(centavos);
}

/** `MM/DD/YYYY`. */
export function slashDate(day: BusinessDate | null): string {
  return day ? `${day.slice(5, 7)}/${day.slice(8, 10)}/${day.slice(0, 4)}` : '';
}

/** `MMDDYYYY`. */
export function compactDate(day: BusinessDate | null): string {
  return day ? `${day.slice(5, 7)}${day.slice(8, 10)}${day.slice(0, 4)}` : '';
}

/** Thrown when a value can't fit its fixed-width field. Names the field, never the value. */
export class RemittanceFieldWidthError extends Error {
  constructor(field: string, width: number) {
    super(`The ${field} doesn’t fit its ${width}-character field in the upload file.`);
    this.name = 'RemittanceFieldWidthError';
  }
}

/** Left-aligned text, padded with spaces and cut to `width`. */
export function leftField(value: string, width: number): string {
  return value.slice(0, width).padEnd(width, ' ');
}

/** A right-aligned number, padded with spaces; refused when it doesn't fit. */
export function rightField(value: string, width: number, field: string): string {
  if (value.length > width) throw new RemittanceFieldWidthError(field, width);
  return value.padStart(width, ' ');
}

/** A zero-padded count; refused when it doesn't fit. */
export function countField(count: number, width: number, field: string): string {
  const text = String(count);
  if (text.length > width) throw new RemittanceFieldWidthError(field, width);
  return text.padStart(width, '0');
}

/** One comma-separated value: quoted when it holds a comma or a quote (quotes doubled). */
export function csvValue(value: string): string {
  return /[",]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/** One comma-separated line of ASCII values. */
export function csvLine(values: readonly string[]): string {
  return values.map(csvValue).join(',');
}

/** The file's text: each line ended with CR LF. */
export function fileText(lines: readonly string[]): string {
  return lines.map((line) => `${line}${CRLF}`).join('');
}
