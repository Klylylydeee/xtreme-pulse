import type { Types } from 'mongoose';
import { connectDb } from '@pulse/db';
import { type BusinessDate, businessToday } from '@pulse/core';
import { userNames } from '@pulse/core/server';
import {
  formatRemittanceMonth,
  goLivePeriodsText,
  hasRemittanceUpload,
  isRemittanceAgency,
  isRemittanceMonth,
  monthOfDay,
  REMITTANCE_AGENCIES,
  REMITTANCE_AGENCY_LABELS,
  REMITTANCE_BIR_NO_UPLOAD_TEXT,
  REMITTANCE_FISCAL_PLACEHOLDER_TEXT,
  REMITTANCE_GO_LIVE_REQUIRED_MESSAGE,
  REMITTANCE_NOTE_HINT,
  REMITTANCE_REVEAL_NOTE,
  REMITTANCE_STATUS_LABELS,
  type RemittanceAgency,
  remittanceDueDate,
  remittanceDueText,
  remittanceFormatById,
  remittanceGoLiveNoteText,
  remittanceMissingIdsRefusal,
  type RemittanceMonth,
  remittanceMonthsThrough,
  remittancePaidText,
  remittancePlaceholderRefusal,
  remittancePlaceholderWarning,
  type RemittanceStatus,
  remittanceTitle,
  remittanceUnverifiedFormatWarning,
  remittanceUploadButtonLabel,
} from '../../remittance';
import { formatPeriodRange } from '../../timesheets/submission';
import {
  assertCanSeeRemittances,
  canGenerateRemittances,
  canRecordRemittancePayments,
  type TalentActor,
} from '../policy';
import { dayOf } from '../shared';
import {
  type RemittancePaymentDocument,
  RemittancePaymentModel,
  type RemittanceReportDocument,
  RemittanceReportModel,
} from './model';
import {
  loadMonthSources,
  loadRemittanceContext,
  type RemittanceContext,
  type RemittanceMonthSources,
  remittanceSettingsFor,
} from './sources';

// Spec: docs/modules/talent.md#employer-contributions-and-remittances-build-step-211 ("Statuses",
// "Paid per agency per month", "Screens", "Cross-module and services"; decisions 385, 391, 396 and
// 398 in docs/BUILD_PLAN.md) — each agency's month and its status, the remittances page and a
// report's page, with no amount and no ID number: those come only from "Show amounts"
// (./view.ts) and the exports (./exports.ts), each audited first.
//
// - The status is derived: `notReady` (a cut-off paid in the month isn't finalized), `ready`
//   (complete, no report), `generated`, `paid` (a live payment). Not `paid` after the due date also
//   shows "Overdue". The due date is today's setting's (the version in effect on the first of the
//   next month), never moved for weekends or holidays.
// - Seeing: Talent Read and HR, Accounting or the System Administrator.
// - `getRemittanceStatus(agency, month)`: server-only, no access check, for step 2.16 (the reports
//   hub) and step 5.8 (the disbursement).

export const REMITTANCES_HREF = '/talent/remittances';

/** `/talent/remittances/<YYYY-MM>/<agency>`. */
export function remittanceReportHref(month: RemittanceMonth, agency: RemittanceAgency): string {
  return `${REMITTANCES_HREF}/${month}/${agency}`;
}

/** The refusal for an unknown agency or month. */
export const REMITTANCE_NOT_FOUND =
  'This remittance doesn’t exist. Open it from the remittances page.';
/** The refusal when the report hasn't been generated. */
export const REMITTANCE_REPORT_MISSING = 'Generate the report first.';

/** A live payment, plain (no amount). */
export interface RemittanceLivePayment {
  id: string;
  paidOn: BusinessDate;
  referenceNumber: string;
}

/** One agency's month: its status, due date and live payment, with no amount. */
export interface RemittanceAgencyStatus {
  agency: RemittanceAgency;
  month: RemittanceMonth;
  status: RemittanceStatus;
  dueDate: BusinessDate;
  /** True when not paid after the due date. */
  overdue: boolean;
  reportId: string | null;
  reportVersion: number | null;
  payment: RemittanceLivePayment | null;
}

type ReportStatusRow = Pick<
  RemittanceReportDocument,
  '_id' | 'agency' | 'month' | 'status' | 'version' | 'paymentId'
>;
type PaymentRow = Pick<RemittancePaymentDocument, '_id' | 'paidOn' | 'referenceNumber'>;

const key = (month: RemittanceMonth, agency: RemittanceAgency) => `${month}:${agency}`;

/** Every agency's status for `months`, from one read of the reports and live payments. */
export async function loadRemittanceStatuses(
  context: RemittanceContext,
  months: readonly RemittanceMonth[],
  sources?: Map<RemittanceMonth, RemittanceMonthSources>,
): Promise<Map<string, RemittanceAgencyStatus>> {
  const monthSources = sources ?? (await loadMonthSources(context, months));
  const reports =
    months.length === 0
      ? []
      : await RemittanceReportModel.find(
          { month: { $in: [...months] } },
          { agency: 1, month: 1, status: 1, version: 1, paymentId: 1 },
        ).lean<ReportStatusRow[]>();
  const paymentIds = reports.flatMap((report) => (report.paymentId ? [report.paymentId] : []));
  const payments =
    paymentIds.length === 0
      ? []
      : await RemittancePaymentModel.find(
          { _id: { $in: paymentIds } },
          { paidOn: 1, referenceNumber: 1 },
        ).lean<PaymentRow[]>();
  const paymentOf = new Map(payments.map((payment) => [payment._id.toHexString(), payment]));
  const reportOf = new Map(reports.map((report) => [key(report.month, report.agency), report]));

  const result = new Map<string, RemittanceAgencyStatus>();
  for (const month of months) {
    const settings = remittanceSettingsFor(context, month).value;
    const complete = monthSources.get(month)?.incompleteMessage === null;
    for (const agency of REMITTANCE_AGENCIES) {
      const report = reportOf.get(key(month, agency)) ?? null;
      const paymentRow = report?.paymentId ? paymentOf.get(report.paymentId.toHexString()) : null;
      const status: RemittanceStatus =
        report?.status === 'paid' ? 'paid' : report ? 'generated' : complete ? 'ready' : 'notReady';
      const dueDate = remittanceDueDate(agency, month, settings);
      result.set(key(month, agency), {
        agency,
        month,
        status,
        dueDate,
        overdue: status !== 'paid' && context.today > dueDate,
        reportId: report?._id.toHexString() ?? null,
        reportVersion: report?.version ?? null,
        payment:
          status === 'paid' && paymentRow
            ? {
                id: paymentRow._id.toHexString(),
                paidOn: dayOf(paymentRow.paidOn),
                referenceNumber: paymentRow.referenceNumber,
              }
            : null,
      });
    }
  }
  return result;
}

/**
 * Server-only, for step 2.16 (the reports hub) and step 5.8 (the disbursement): `agency`'s status
 * for `month`, with its due date and live payment (no amount). No access check and no audit; the
 * caller checks. Null for a month before the first remittance month or while the go-live date is
 * null.
 */
export async function getRemittanceStatus(
  agency: RemittanceAgency,
  month: RemittanceMonth,
  { today = businessToday() }: { today?: BusinessDate } = {},
): Promise<RemittanceAgencyStatus | null> {
  if (!isRemittanceAgency(agency) || !isRemittanceMonth(month)) return null;
  const context = await loadRemittanceContext(today);
  if (!context.firstMonth || month < context.firstMonth) return null;
  const statuses = await loadRemittanceStatuses(context, [month]);
  return statuses.get(key(month, agency)) ?? null;
}

// ---------------------------------------------------------------------------------------------
// The remittances page

/** One agency's row on the remittances page. */
export interface RemittanceListRow extends RemittanceAgencyStatus {
  agencyLabel: string;
  statusLabel: string;
  /** "Due Nov 30, 2026". */
  dueText: string;
  /** "Paid Nov 27, 2026 · PRN 1234567890123", or null. */
  paidText: string | null;
  href: string;
}

export interface RemittanceMonthGroup {
  month: RemittanceMonth;
  /** "October 2026". */
  label: string;
  agencies: RemittanceListRow[];
}

export interface RemittanceListView {
  /** "Set the go-live date in Payroll settings › Leave first." while it is null; else null. */
  goLiveRequiredMessage: string | null;
  /** From the first remittance month through this month, newest first. */
  months: RemittanceMonthGroup[];
}

function listRowOf(status: RemittanceAgencyStatus): RemittanceListRow {
  return {
    ...status,
    agencyLabel: REMITTANCE_AGENCY_LABELS[status.agency],
    statusLabel: REMITTANCE_STATUS_LABELS[status.status],
    dueText: remittanceDueText(status.dueDate),
    paidText: status.payment
      ? remittancePaidText(status.payment.paidOn, status.payment.referenceNumber)
      : null,
    href: remittanceReportHref(status.month, status.agency),
  };
}

/** `/talent/remittances`: Talent Read and HR, Accounting or the System Administrator. */
export async function listRemittances(actor: TalentActor): Promise<RemittanceListView> {
  assertCanSeeRemittances(actor);
  const today = businessToday();
  const context = await loadRemittanceContext(today);
  if (!context.firstCutOff) {
    return { goLiveRequiredMessage: REMITTANCE_GO_LIVE_REQUIRED_MESSAGE, months: [] };
  }
  const months = remittanceMonthsThrough(context.firstCutOff, monthOfDay(today));
  const statuses = await loadRemittanceStatuses(context, months);
  return {
    goLiveRequiredMessage: null,
    months: months.map((month) => ({
      month,
      label: formatRemittanceMonth(month),
      agencies: REMITTANCE_AGENCIES.flatMap((agency) => {
        const status = statuses.get(key(month, agency));
        return status ? [listRowOf(status)] : [];
      }),
    })),
  };
}

// ---------------------------------------------------------------------------------------------
// A report's page

/** A source run, linking to it. */
export interface RemittanceSourceRunView {
  runId: string;
  number: string;
  /** "Sep 26 – Oct 10, 2026". */
  periodText: string;
  href: string;
}

/** One entry of the payment chain, plain (no amount). */
export interface RemittancePaymentEntryView {
  id: string;
  /** `payment` (the first, or one recorded again after a void), `correction` or `void`. */
  kind: 'payment' | 'correction' | 'void';
  paidOn: BusinessDate;
  referenceNumber: string;
  note: string | null;
  reason: string | null;
  recordedAt: Date;
  recordedByName: string | null;
}

/** The upload file's button and warning (null for BIR 1601-C). */
export interface RemittanceUploadView {
  formatId: string;
  formatLabel: string;
  verified: boolean;
  /** "Upload file (layout not verified)". */
  buttonLabel: string;
  /** The not-verified warning, or null once verified. */
  warning: string | null;
  /** Why it can't be built now (missing IDs, a placeholder), or null. */
  refusal: string | null;
}

/** The generated report, plain (counts and flags only). */
export interface RemittanceReportSummary {
  id: string;
  version: number;
  generatedAt: Date;
  generatedByName: string | null;
  employeeCount: number;
  flagCounts: { differsFromSchedule: number; missingId: number; unverifiedId: number };
  /** The placeholder warning, or null. */
  placeholderWarning: string | null;
  /** The upload file, or null for BIR 1601-C. */
  upload: RemittanceUploadView | null;
  /** "BIR Form 1601-C has no upload file: …", or null. */
  noUploadText: string | null;
}

export interface RemittanceReportPageView {
  agency: RemittanceAgency;
  agencyLabel: string;
  month: RemittanceMonth;
  monthLabel: string;
  /** "SSS · October 2026". */
  title: string;
  status: RemittanceStatus;
  statusLabel: string;
  overdue: boolean;
  dueDate: BusinessDate;
  dueText: string;
  /** "Set the go-live date …", or why the month isn't complete; null when it is. */
  incompleteMessage: string | null;
  sourceRuns: RemittanceSourceRunView[];
  /** The go-live month's note, or null. */
  goLiveNote: string | null;
  report: RemittanceReportSummary | null;
  canGenerate: boolean;
  canRecordPayment: boolean;
  /** The live payment, or null. */
  livePayment: RemittancePaymentEntryView | null;
  /** The whole chain, newest first. */
  paymentHistory: RemittancePaymentEntryView[];
  fiscalPlaceholderText: string;
  revealNote: string;
  noteHint: string;
}

type ReportPageRow = Omit<RemittanceReportDocument, 'rows' | 'totals'>;
type PaymentChainRow = Omit<RemittancePaymentDocument, 'amountCentavos'>;

/** The chain of a report's payments, oldest first, and its live entry (null when voided). */
export function paymentChainOf<
  T extends Pick<RemittancePaymentDocument, '_id' | 'supersedesId' | 'voided'>,
>(entries: readonly T[]): { chain: T[]; live: T | null } {
  const bySuperseded = new Map(
    entries.flatMap((entry) =>
      entry.supersedesId ? [[entry.supersedesId.toHexString(), entry]] : [],
    ),
  );
  const chain: T[] = [];
  let current = entries.find((entry) => entry.supersedesId === null) ?? null;
  while (current) {
    chain.push(current);
    current = bySuperseded.get(current._id.toHexString()) ?? null;
  }
  const last = chain[chain.length - 1] ?? null;
  return { chain, live: last && !last.voided ? last : null };
}

function entryKind(
  entry: Pick<RemittancePaymentDocument, 'voided' | 'supersedesId'>,
  previous: Pick<RemittancePaymentDocument, 'voided'> | null,
): RemittancePaymentEntryView['kind'] {
  if (entry.voided) return 'void';
  if (!entry.supersedesId || previous?.voided) return 'payment';
  return 'correction';
}

/**
 * A report's page (`/talent/remittances/<YYYY-MM>/<agency>`), with no amount and no ID. Null for
 * an unknown agency or month, or a month before the first remittance month. Talent Read and HR,
 * Accounting or the System Administrator.
 */
export async function getRemittanceReportPage(
  actor: TalentActor,
  month: string,
  agency: string,
): Promise<RemittanceReportPageView | null> {
  assertCanSeeRemittances(actor);
  if (!isRemittanceMonth(month) || !isRemittanceAgency(agency)) return null;
  const today = businessToday();
  const context = await loadRemittanceContext(today);
  await connectDb();
  const base = {
    agency,
    agencyLabel: REMITTANCE_AGENCY_LABELS[agency],
    month,
    monthLabel: formatRemittanceMonth(month),
    title: remittanceTitle(agency, month),
    canGenerate: canGenerateRemittances(actor),
    canRecordPayment: canRecordRemittancePayments(actor),
    fiscalPlaceholderText: REMITTANCE_FISCAL_PLACEHOLDER_TEXT,
    revealNote: REMITTANCE_REVEAL_NOTE,
    noteHint: REMITTANCE_NOTE_HINT,
  };
  if (!context.firstCutOff || !context.firstMonth) {
    return null;
  }
  if (month < context.firstMonth || month > monthOfDay(today)) return null;

  const sources = await loadMonthSources(context, [month]);
  const monthSources = sources.get(month);
  const statuses = await loadRemittanceStatuses(context, [month], sources);
  const status = statuses.get(key(month, agency));
  if (!monthSources || !status) return null;

  const report = await RemittanceReportModel.findOne({ agency, month }).lean<ReportPageRow>();
  const entries = report
    ? await RemittancePaymentModel.find({ reportId: report._id })
        .sort({ createdAt: 1 })
        .lean<PaymentChainRow[]>()
    : [];
  const { chain, live } = paymentChainOf(entries);
  const ids: Types.ObjectId[] = [
    ...(report?.generatedBy ? [report.generatedBy] : []),
    ...chain.flatMap((entry) => (entry.createdBy ? [entry.createdBy] : [])),
  ];
  const names = await userNames(ids);
  const nameOf = (id: Types.ObjectId | null) => (id ? (names.get(id.toHexString()) ?? null) : null);
  const views = chain.map((entry, index): RemittancePaymentEntryView => ({
    id: entry._id.toHexString(),
    kind: entryKind(entry, chain[index - 1] ?? null),
    paidOn: dayOf(entry.paidOn),
    referenceNumber: entry.referenceNumber,
    note: entry.note,
    reason: entry.reason,
    recordedAt: entry.createdAt,
    recordedByName: nameOf(entry.createdBy),
  }));

  // The source runs: the report's when generated, else the month's cut-offs' runs so far.
  const sourceRuns: RemittanceSourceRunView[] = report
    ? report.sourceRuns.map((run) => ({
        runId: run.runId.toHexString(),
        number: run.number,
        periodText: formatPeriodRange(dayOf(run.periodStart), dayOf(run.periodEnd)),
        href: `/talent/payroll/${run.runId.toHexString()}`,
      }))
    : [...monthSources.runs.values()].map((run) => ({
        runId: run._id.toHexString(),
        number: run.number,
        periodText: formatPeriodRange(dayOf(run.periodStart), dayOf(run.periodEnd)),
        href: `/talent/payroll/${run._id.toHexString()}`,
      }));
  const goLivePeriods = report
    ? report.goLiveNote
    : goLivePeriodsText(monthSources.paidBeforeGoLive);

  let summary: RemittanceReportSummary | null = null;
  if (report) {
    const format = remittanceFormatById(report.formatId);
    const refusal =
      report.flagCounts.missingId > 0
        ? remittanceMissingIdsRefusal(agency, report.flagCounts.missingId)
        : report.employer.placeholder
          ? remittancePlaceholderRefusal(agency)
          : null;
    summary = {
      id: report._id.toHexString(),
      version: report.version,
      generatedAt: report.generatedAt,
      generatedByName: nameOf(report.generatedBy),
      employeeCount: report.employeeCount,
      flagCounts: {
        differsFromSchedule: report.flagCounts.differsFromSchedule,
        missingId: report.flagCounts.missingId,
        unverifiedId: report.flagCounts.unverifiedId,
      },
      placeholderWarning: report.employer.placeholder ? remittancePlaceholderWarning(agency) : null,
      upload:
        hasRemittanceUpload(agency) && format
          ? {
              formatId: format.id,
              formatLabel: format.label,
              verified: format.verified,
              buttonLabel: remittanceUploadButtonLabel(format.verified),
              warning: format.verified ? null : remittanceUnverifiedFormatWarning(agency),
              refusal,
            }
          : null,
      noUploadText: hasRemittanceUpload(agency) ? null : REMITTANCE_BIR_NO_UPLOAD_TEXT,
    };
  }

  return {
    ...base,
    status: status.status,
    statusLabel: REMITTANCE_STATUS_LABELS[status.status],
    overdue: status.overdue,
    dueDate: status.dueDate,
    dueText: remittanceDueText(status.dueDate),
    incompleteMessage: monthSources.incompleteMessage,
    sourceRuns,
    goLiveNote: goLivePeriods ? remittanceGoLiveNoteText(goLivePeriods) : null,
    report: summary,
    livePayment: live ? (views.find((view) => view.id === live._id.toHexString()) ?? null) : null,
    paymentHistory: [...views].reverse(),
  };
}

export { key as remittanceStatusKey };
