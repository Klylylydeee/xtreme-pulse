import { Types } from 'mongoose';
import { connectDb } from '@pulse/db';
import { type BusinessDate, formatDate } from '@pulse/core';
import {
  CompanySettingsMissingError,
  getCompanyLogoFile,
  getCompanySettings,
  openStoredFile,
  saveGeneratedFile,
  StoredFileMissingError,
} from '@pulse/core/server';
import { PDF_CONTENT_TYPE } from '@pulse/core/server/exports';
import { SALARY_MASK } from '../../formats';
import { formatPeriodRange } from '../../timesheets/submission';
import type { MaskedAmountView } from '../../views';
import { getPayslip, type PayslipRecord } from '../payroll-review/payslip';
import {
  PAYROLL_RUN_EMPLOYEE_RECORD_TYPE,
  type PayrollRunDocument,
  type PayrollRunEmployeeDocument,
  PayrollRunEmployeeModel,
  PayrollRunModel,
} from '../payroll-runs/model';
import { canOpenPayslip, type TalentActor } from '../policy';
import { dayOf, objectIdOf } from '../shared';
import { PAYSLIP_LOGO_TYPES, type PayslipCompany, renderPayslipPdf } from './document';

// Spec: docs/modules/talent.md#payroll-review-approval-and-payslips-build-step-210 ("Payslips":
// the PDF, the job, self-service and who opens a payslip; decisions 363, 364 and 366 in
// docs/BUILD_PLAN.md), docs/ARCHITECTURE.md#file-storage and SECURITY.md#sensitive-data
// ("Payslips") — the payslip PDFs of finalized runs.
//
// - `renderPayslipFile(lineId)`: renders one finalized line's payslip from its frozen snapshot
//   (`getPayslip`) and Core's company details as they are now, saves it with `saveGeneratedFile`
//   (owner `talent.payslip`, the line's id; `idempotencyKey` `talent.payslip:<line id>`; "Payslip
//   <employee number> <pay date>.pdf"), and sets `payslip.fileId` and `payslip.generatedAt` once
//   (filtered on `payslip.fileId: null`; the model's guard checks the run is finalized). Two renders
//   racing on one line both get the same stored file from the idempotency key (Core removes the
//   loser's bytes), and the loser's `updateOne` matches nothing, so the line keeps one file. Should
//   the line ever point at another file (the key's file soft-deleted by admin tooling), the newly
//   saved file stays unreferenced: the file route opens only the file a line points at (HANDOFF).
// - The job (`./job.ts`) renders every pending run's missing PDFs; opening a payslip whose PDF isn't
//   rendered yet renders it there (`openPayslipHref`).
// - Self-service (`listOwnPayslips`): the signed-in employee's payslips of finalized runs, newest
//   first, with no amount: net pay is masked, revealed through step 2.9's generic
//   `talent.payrollRunEmployee` reveal (field `netPay`, audit-logged).
// - Opening goes through the file route (`talent.payslip`, ../files/registrations.ts), which writes
//   and commits a `reveal` on `talent.payrollRunEmployee` (field `file`) before sending anything.
//
// Nothing here logs or audits an amount, an account number or the PDF's bytes.

/** The file owner type of a payslip PDF (the owner id is the line's id). */
export const PAYSLIP_FILE_TYPE = 'talent.payslip';

/** The idempotency key of a line's payslip PDF. */
export const payslipIdempotencyKey = (lineId: string) => `${PAYSLIP_FILE_TYPE}:${lineId}`;

/** The download name: "Payslip <employee number> <pay date>.pdf". */
export const payslipFileName = (employeeNumber: string, payDate: BusinessDate) =>
  `Payslip ${employeeNumber} ${payDate}.pdf`;

/** The file route URL of a stored payslip PDF. */
export const payslipFileHref = (fileId: string) => `/files/${fileId}`;

/** Reads the logo's bytes, or null when there is none or its content is missing. */
async function logoBytes(): Promise<PayslipCompany['logo']> {
  const file = await getCompanyLogoFile();
  // react-pdf draws PNG and JPEG only. A WebP logo is left out: Core's image transform isn't
  // exported, and step 2.10 adds no Core change (HANDOFF).
  if (!file || !(PAYSLIP_LOGO_TYPES as readonly string[]).includes(file.contentType)) return null;
  try {
    const { stream } = await openStoredFile(file);
    const bytes = new Uint8Array(await new Response(stream).arrayBuffer());
    return { bytes, contentType: file.contentType };
  } catch (error) {
    if (error instanceof StoredFileMissingError) return null;
    throw error;
  }
}

/**
 * The company header as it is now: the registered name, business address and logo (a placeholder
 * prints as it is). Null when there is no company settings record (before the seed).
 */
export async function loadPayslipCompany(): Promise<PayslipCompany | null> {
  let settings;
  try {
    settings = await getCompanySettings();
  } catch (error) {
    if (error instanceof CompanySettingsMissingError) return null;
    throw error;
  }
  return {
    registeredName: settings.registeredName,
    businessAddress: settings.businessAddress,
    logo: await logoBytes(),
  };
}

export interface RenderPayslipOptions {
  /** The company header, when the caller has read it already (the job reads it once). */
  company?: PayslipCompany | null;
  /** Who caused the render: the employee or HR opening it, or null for the job. */
  actorId?: string | null;
}

/** A rendered payslip: the line's file. */
export interface RenderedPayslip {
  lineId: string;
  fileId: string;
  /** True when this call rendered and set it; false when the line had its file already. */
  rendered: boolean;
}

/**
 * Renders and saves `payslip`'s PDF and sets the file on its line, unless it has one (see the
 * header). Returns the line's file. Throws when the run left `finalized` (it never does).
 */
async function renderPayslipRecord(
  payslip: PayslipRecord,
  { company, actorId = null }: RenderPayslipOptions,
): Promise<RenderedPayslip> {
  if (payslip.fileId) return { lineId: payslip.lineId, fileId: payslip.fileId, rendered: false };
  const header = company === undefined ? await loadPayslipCompany() : company;
  const bytes = await renderPayslipPdf(payslip.view, header);
  const actor = actorId ? objectIdOf(actorId) : null;
  const file = await saveGeneratedFile({
    bytes,
    contentType: PDF_CONTENT_TYPE,
    fileName: payslipFileName(payslip.snapshot.employeeNumber, payslip.payDate),
    owner: { type: PAYSLIP_FILE_TYPE, id: new Types.ObjectId(payslip.lineId) },
    actorId: actor,
    idempotencyKey: payslipIdempotencyKey(payslip.lineId),
  });
  const result = await PayrollRunEmployeeModel.updateOne(
    {
      _id: new Types.ObjectId(payslip.lineId),
      runId: new Types.ObjectId(payslip.runId),
      'payslip.fileId': null,
    },
    {
      $set: {
        'payslip.fileId': new Types.ObjectId(file.id),
        'payslip.generatedAt': new Date(),
        updatedBy: actor,
      },
    },
  );
  if (result.modifiedCount === 1)
    return { lineId: payslip.lineId, fileId: file.id, rendered: true };
  // Another render set it first: keep the line's file (the same one, through the key).
  const line = await PayrollRunEmployeeModel.findById(new Types.ObjectId(payslip.lineId), {
    'payslip.fileId': 1,
  }).lean<Pick<PayrollRunEmployeeDocument, '_id' | 'payslip'>>();
  const stored = line?.payslip?.fileId?.toHexString();
  if (!stored) throw new Error('The payslip file could not be set on its payroll run line.');
  return { lineId: payslip.lineId, fileId: stored, rendered: false };
}

/**
 * Renders a finalized line's payslip PDF if it has none yet, and returns its file; null when the
 * line doesn't exist or its run isn't finalized. Idempotent and safe to race. No access check:
 * callers are the job and `openPayslipHref`, which checks access.
 */
export async function renderPayslipFile(
  lineId: string,
  options: RenderPayslipOptions = {},
): Promise<RenderedPayslip | null> {
  const payslip = await getPayslip(lineId);
  if (!payslip) return null;
  return renderPayslipRecord(payslip, options);
}

/**
 * "Open payslip": the file route URL of `lineId`'s payslip PDF for `actor`, rendering it first
 * when it isn't rendered yet. Null when the line doesn't exist, isn't finalized, or `actor` may
 * not open it (the employee's own, or Talent Read and HR, Accounting or the System
 * Administrator), the same answer for each so ids can't be probed. Opening the URL writes the
 * `reveal` entry (the file route's `auditView`); this writes none.
 */
export async function openPayslipHref(actor: TalentActor, lineId: string): Promise<string | null> {
  const payslip = await getPayslip(lineId);
  if (!payslip || !canOpenPayslip(actor, payslip.employeeId)) return null;
  const { fileId } = await renderPayslipRecord(payslip, { actorId: actor.id });
  return payslipFileHref(fileId);
}

/** One payslip in the employee's own list (`/talent/me#payslips`). No amount. */
export interface OwnPayslipRow {
  lineId: string;
  runId: string;
  runNumber: string;
  periodStart: BusinessDate;
  periodEnd: BusinessDate;
  /** "Sep 26 – Oct 10, 2026". */
  periodText: string;
  payDate: BusinessDate;
  /** "Oct 15, 2026". */
  payDateText: string;
  /** Net pay, masked; revealed through the generic `talent.payrollRunEmployee` reveal. */
  netPay: MaskedAmountView;
  /** True once the PDF is rendered; "Open payslip" renders it otherwise. */
  ready: boolean;
}

/**
 * The signed-in user's own payslips (self-service, no module access needed): one per line of a
 * finalized run, newest pay date first. Empty without an employee.
 */
export async function listOwnPayslips(actor: TalentActor): Promise<OwnPayslipRow[]> {
  const employeeId = actor.employee ? objectIdOf(actor.employee.id) : null;
  if (!employeeId) return [];
  await connectDb();
  const lines = await PayrollRunEmployeeModel.find(
    { employeeId, payslip: { $type: 'object' } },
    { runId: 1, 'payslip.fileId': 1 },
  ).lean<Pick<PayrollRunEmployeeDocument, '_id' | 'runId' | 'payslip'>[]>();
  if (lines.length === 0) return [];
  const runs = await PayrollRunModel.find(
    { _id: { $in: lines.map((line) => line.runId) }, status: 'finalized' },
    { number: 1, periodStart: 1, periodEnd: 1, payDate: 1 },
  ).lean<Pick<PayrollRunDocument, '_id' | 'number' | 'periodStart' | 'periodEnd' | 'payDate'>[]>();
  const runOf = new Map(runs.map((run) => [run._id.toHexString(), run]));
  const rows: OwnPayslipRow[] = [];
  for (const line of lines) {
    const run = runOf.get(line.runId.toHexString());
    if (!run) continue;
    const lineId = line._id.toHexString();
    const periodStart = dayOf(run.periodStart);
    const periodEnd = dayOf(run.periodEnd);
    const payDate = dayOf(run.payDate);
    rows.push({
      lineId,
      runId: run._id.toHexString(),
      runNumber: run.number,
      periodStart,
      periodEnd,
      periodText: formatPeriodRange(periodStart, periodEnd),
      payDate,
      payDateText: formatDate(payDate),
      netPay: {
        ownerType: PAYROLL_RUN_EMPLOYEE_RECORD_TYPE,
        ownerId: lineId,
        field: 'netPay',
        mask: SALARY_MASK,
      },
      ready: Boolean(line.payslip?.fileId),
    });
  }
  return rows.sort(
    (a, b) =>
      b.payDate.localeCompare(a.payDate) ||
      b.periodStart.localeCompare(a.periodStart) ||
      b.runNumber.localeCompare(a.runNumber),
  );
}
