import { type BusinessDate, formatDate } from '@pulse/core';
import { formatPeriodRange } from '../timesheets/submission';

// Spec: docs/modules/talent.md#employer-contributions-and-remittances-build-step-211 (decisions
// 377–400 in docs/BUILD_PLAN.md; HANDOFF items 373–398) — the remittance agencies, statuses and
// the words the screens, the exports and the reminder job use. Pure code, safe in the browser.
// Nothing here holds an amount or an ID number.

/** The four remittances of a month, in the order the screens list them. */
export const REMITTANCE_AGENCIES = ['sss', 'philhealth', 'pagibig', 'bir1601c'] as const;
export type RemittanceAgency = (typeof REMITTANCE_AGENCIES)[number];

/** The agencies with an upload file (BIR 1601-C is typed into eFPS or eBIRForms). */
export const REMITTANCE_UPLOAD_AGENCIES = ['sss', 'philhealth', 'pagibig'] as const;
export type RemittanceUploadAgency = (typeof REMITTANCE_UPLOAD_AGENCIES)[number];

export const REMITTANCE_AGENCY_LABELS: Record<RemittanceAgency, string> = {
  sss: 'SSS',
  philhealth: 'PhilHealth',
  pagibig: 'Pag-IBIG',
  bir1601c: 'BIR 1601-C',
};

export function isRemittanceAgency(value: unknown): value is RemittanceAgency {
  return typeof value === 'string' && (REMITTANCE_AGENCIES as readonly string[]).includes(value);
}

export function hasRemittanceUpload(agency: RemittanceAgency): agency is RemittanceUploadAgency {
  return (REMITTANCE_UPLOAD_AGENCIES as readonly string[]).includes(agency);
}

/** The employee's ID each report needs: "SS number", "PhilHealth PIN", "Pag-IBIG MID", "TIN". */
export const REMITTANCE_ID_LABELS: Record<RemittanceAgency, { one: string; many: string }> = {
  sss: { one: 'SS number', many: 'SS numbers' },
  philhealth: { one: 'PhilHealth PIN', many: 'PhilHealth PINs' },
  pagibig: { one: 'Pag-IBIG MID', many: 'Pag-IBIG MIDs' },
  bir1601c: { one: 'TIN', many: 'TINs' },
};

/** The company detail each report prints as the employer's number. */
export const REMITTANCE_EMPLOYER_NUMBER_LABELS: Record<RemittanceAgency, string> = {
  sss: 'SSS employer number',
  philhealth: 'PhilHealth employer number',
  pagibig: 'Pag-IBIG employer ID',
  bir1601c: 'company TIN',
};

/**
 * An agency's month, derived (decision 385): `notReady` (the month isn't complete), `ready`
 * (complete, no report), `generated`, `paid` (a live payment). Stored on a report: `generated`
 * or `paid`.
 */
export const REMITTANCE_STATUSES = ['notReady', 'ready', 'generated', 'paid'] as const;
export type RemittanceStatus = (typeof REMITTANCE_STATUSES)[number];
export const REMITTANCE_REPORT_STATUSES = ['generated', 'paid'] as const;
export type RemittanceReportStatus = (typeof REMITTANCE_REPORT_STATUSES)[number];

export const REMITTANCE_STATUS_LABELS: Record<RemittanceStatus, string> = {
  notReady: 'Not ready',
  ready: 'Ready to generate',
  generated: 'Generated',
  paid: 'Paid',
};
export const REMITTANCE_OVERDUE_LABEL = 'Overdue';

/** The three exports of a report. */
export const REMITTANCE_EXPORT_FORMATS = ['pdf', 'xlsx', 'upload'] as const;
export type RemittanceExportFormat = (typeof REMITTANCE_EXPORT_FORMATS)[number];

// ---------------------------------------------------------------------------------------------
// Months

/** A remittance month: `YYYY-MM`, a payroll run's contribution month (the pay date's month). */
export type RemittanceMonth = string;

const MONTH_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;

export function isRemittanceMonth(value: unknown): value is RemittanceMonth {
  return typeof value === 'string' && MONTH_PATTERN.test(value);
}

const MONTH_NAMES = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
] as const;

/** "October 2026". */
export function formatRemittanceMonth(month: RemittanceMonth): string {
  return `${MONTH_NAMES[Number(month.slice(5, 7)) - 1]} ${month.slice(0, 4)}`;
}

/** The month `count` months after `month` (negative for before). */
export function addRemittanceMonths(month: RemittanceMonth, count: number): RemittanceMonth {
  const index = Number(month.slice(0, 4)) * 12 + Number(month.slice(5, 7)) - 1 + count;
  const year = Math.floor(index / 12);
  return `${String(year).padStart(4, '0')}-${String((index % 12) + 1).padStart(2, '0')}`;
}

/** The month a day falls in. */
export function monthOfDay(day: BusinessDate): RemittanceMonth {
  return day.slice(0, 7);
}

export function firstDayOfMonth(month: RemittanceMonth): BusinessDate {
  return `${month}-01`;
}

export function lastDayOfMonth(month: RemittanceMonth): BusinessDate {
  const year = Number(month.slice(0, 4));
  const index = Number(month.slice(5, 7));
  const days = new Date(Date.UTC(year, index, 0)).getUTCDate();
  return `${month}-${String(days).padStart(2, '0')}`;
}

/** Every month from `first` to `last`, both included, oldest first (empty when `last < first`). */
export function monthsFrom(first: RemittanceMonth, last: RemittanceMonth): RemittanceMonth[] {
  const months: RemittanceMonth[] = [];
  for (let month = first; month <= last; month = addRemittanceMonths(month, 1)) months.push(month);
  return months;
}

// ---------------------------------------------------------------------------------------------
// Words

/** "SSS · October 2026": a report's title on its page, and its audit label. */
export function remittanceTitle(agency: RemittanceAgency, month: RemittanceMonth): string {
  return `${REMITTANCE_AGENCY_LABELS[agency]} · ${formatRemittanceMonth(month)}`;
}

/** The audit label of a report: "<agency> · <YYYY-MM>" (decision 390). */
export function remittanceAuditLabel(agency: RemittanceAgency, month: RemittanceMonth): string {
  return `${REMITTANCE_AGENCY_LABELS[agency]} · ${month}`;
}

/** The export's title: "SSS contributions · October 2026". */
export function remittanceExportTitle(agency: RemittanceAgency, month: RemittanceMonth): string {
  const what: Record<RemittanceAgency, string> = {
    sss: 'SSS contributions',
    philhealth: 'PhilHealth premiums',
    pagibig: 'Pag-IBIG contributions',
    bir1601c: 'BIR Form 1601-C data',
  };
  return `${what[agency]} · ${formatRemittanceMonth(month)}`;
}

/** The export's file name: "SSS October 2026.pdf". */
export function remittanceFileName(
  agency: RemittanceAgency,
  month: RemittanceMonth,
  extension: string,
): string {
  return `${REMITTANCE_AGENCY_LABELS[agency]} ${formatRemittanceMonth(month)}.${extension}`;
}

/** "Due Nov 30, 2026". */
export function remittanceDueText(dueDate: BusinessDate): string {
  return `Due ${formatDate(dueDate)}`;
}

/** "Paid Nov 27, 2026 · PRN 1234567890123". */
export function remittancePaidText(paidOn: BusinessDate, referenceNumber: string): string {
  return `Paid ${formatDate(paidOn)} · ${referenceNumber}`;
}

/** The refusal while a cut-off paid in the month has no run (decision 378). */
export function remittanceComputeFirstMessage(
  periodStart: BusinessDate,
  periodEnd: BusinessDate,
): string {
  return `Compute and finalize the run for ${formatPeriodRange(periodStart, periodEnd)} first.`;
}

/** "Finalize Oct 11 – 25, 2026 first: its pay date is in October 2026." (decision 378). */
export function remittanceFinalizeFirstMessage(
  periodStart: BusinessDate,
  periodEnd: BusinessDate,
  month: RemittanceMonth,
): string {
  return `Finalize ${formatPeriodRange(periodStart, periodEnd)} first: its pay date is in ${formatRemittanceMonth(month)}.`;
}

/** The go-live month's note, naming the cut-offs paid before go-live (decision 378). */
export function remittanceGoLiveNoteText(periodsPaidBefore: string): string {
  const many = periodsPaidBefore.includes(' and ');
  return `Covers only the cut-offs paid in Pulse Talent. ${periodsPaidBefore} ${many ? 'were' : 'was'} paid before go-live: add ${many ? 'their' : 'its'} contributions and tax to this remittance outside Pulse.`;
}

/** The placeholder warning: "The SSS employer number is still a placeholder. …" (decision 386). */
export function remittancePlaceholderWarning(agency: RemittanceAgency): string {
  const label = REMITTANCE_EMPLOYER_NUMBER_LABELS[agency];
  return `The ${label} is still a placeholder. Fill it in in Company settings, then regenerate.`;
}

/** "No SS number on file" and "SS number not verified" (decision 381). */
export function remittanceMissingIdText(agency: RemittanceAgency): string {
  return `No ${REMITTANCE_ID_LABELS[agency].one} on file`;
}
export function remittanceUnverifiedIdText(agency: RemittanceAgency): string {
  return `${REMITTANCE_ID_LABELS[agency].one} not verified`;
}

export const REMITTANCE_DIFFERS_LABEL = 'Differs from the schedule';
export const REMITTANCE_MISSING_ID_TILE_LABEL = 'Missing or unverified ID';
export const REMITTANCE_REVEAL_NOTE = 'Viewing amounts is recorded in the audit log.';
export const REMITTANCE_FISCAL_PLACEHOLDER_TEXT =
  'Pulse Fiscal disbursement: waiting for Pulse Fiscal (Phase 5).';
export const REMITTANCE_BIR_NO_UPLOAD_TEXT =
  'BIR Form 1601-C has no upload file: type these figures into eFPS or eBIRForms.';
export const REMITTANCE_BIR_ADJUSTMENTS_TEXT = 'Fill in on the form if any.';
export const REMITTANCE_NOTE_HINT = 'Don’t type amounts or ID numbers in the note.';
export const REMITTANCE_REPORT_CHANGED_MESSAGE =
  'The report changed since the page loaded. Reload it.';
export const REMITTANCE_PAID_LOCKED_MESSAGE =
  'This report is paid, so it can’t be regenerated. Void the payment first if the report must change.';
export const REMITTANCE_GO_LIVE_REQUIRED_MESSAGE =
  'Set the go-live date in Payroll settings › Leave first.';

/** "Upload file (layout not verified)" while the format isn't verified (decision 388). */
export function remittanceUploadButtonLabel(verified: boolean): string {
  return verified ? 'Upload file' : 'Upload file (layout not verified)';
}

/** The upload sheet's warning while the format isn't verified (decision 388). */
export function remittanceUnverifiedFormatWarning(agency: RemittanceAgency): string {
  return `This layout hasn’t been checked against ${REMITTANCE_AGENCY_LABELS[agency]}’s official file specification. Check it with the portal’s validation before relying on it.`;
}

/** The refusal while rows have no ID: "Enter the SS numbers of 1 employee first." (decision 381). */
export function remittanceMissingIdsRefusal(agency: RemittanceAgency, count: number): string {
  return `Enter the ${REMITTANCE_ID_LABELS[agency].many} of ${count} ${count === 1 ? 'employee' : 'employees'} first.`;
}

/** The refusal while the employer number is a placeholder (decision 386). */
export function remittancePlaceholderRefusal(agency: RemittanceAgency): string {
  return `Fill in the ${REMITTANCE_EMPLOYER_NUMBER_LABELS[agency]} in Company settings, then regenerate the report.`;
}

/** The amount warning (decision 391): "₱7,200.00 isn't the report's amount due of ₱7,185.00. …". */
export function remittanceAmountWarning(paidText: string, dueText: string): string {
  return `${paidText} isn’t the report’s amount due of ${dueText}. Save anyway if penalties or another month are included.`;
}

// ---------------------------------------------------------------------------------------------
// The reminder job's words (decision 393): no amount.

export const REMITTANCE_REMINDER_KINDS = ['soon', 'today', 'overdue'] as const;
export type RemittanceReminderKind = (typeof REMITTANCE_REMINDER_KINDS)[number];

/** "SSS remittance for October 2026 is due Nov 30, 2026" (and "… due today", "… overdue"). */
export function remittanceReminderText(
  kind: RemittanceReminderKind,
  agency: RemittanceAgency,
  month: RemittanceMonth,
  dueDate: BusinessDate,
): string {
  const what = `${REMITTANCE_AGENCY_LABELS[agency]} remittance for ${formatRemittanceMonth(month)}`;
  switch (kind) {
    case 'soon':
      return `${what} is due ${formatDate(dueDate)}`;
    case 'today':
      return `${what} is due today`;
    case 'overdue':
      return `${what} is overdue (due ${formatDate(dueDate)})`;
  }
}

/**
 * Which reminder is due on `today` for a due date, or null: `soon` from `leadDays` before the
 * due date until the day before it (so a missed run catches up), `today` on it, `overdue` from the
 * day after. Each is sent once (the job's `dedupeKey`).
 */
export function remittanceReminderKindOn(
  today: BusinessDate,
  dueDate: BusinessDate,
  soonFrom: BusinessDate,
): RemittanceReminderKind | null {
  if (today > dueDate) return 'overdue';
  if (today === dueDate) return 'today';
  if (today >= soonFrom) return 'soon';
  return null;
}
