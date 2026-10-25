import { Types } from 'mongoose';
import { connectDb } from '@pulse/db';
import { ActionError, type Centavos, formatDate, formatPeso } from '@pulse/core';
import { recordAudit, saveGeneratedFile } from '@pulse/core/server';
import {
  buildReportWorkbook,
  PDF_CONTENT_TYPE,
  type Report,
  type ReportColumn,
  XLSX_CONTENT_TYPE,
} from '@pulse/core/server/exports';
import {
  hasRemittanceUpload,
  isRemittanceAgency,
  isRemittanceMonth,
  REMITTANCE_BIR_ADJUSTMENTS_TEXT,
  REMITTANCE_BIR_NO_UPLOAD_TEXT,
  REMITTANCE_DIFFERS_LABEL,
  REMITTANCE_EMPLOYER_NUMBER_LABELS,
  REMITTANCE_EXPORT_FORMATS,
  REMITTANCE_ID_LABELS,
  REMITTANCE_REPORT_CHANGED_MESSAGE,
  type RemittanceAgency,
  remittanceAuditLabel,
  remittanceDueText,
  type RemittanceExportFormat,
  remittanceExportTitle,
  remittanceFileName,
  remittanceFormatById,
  remittanceGoLiveNoteText,
  remittanceMissingIdText,
  remittanceMissingIdsRefusal,
  remittancePaidText,
  remittancePlaceholderRefusal,
  remittancePlaceholderWarning,
  type RemittanceRow,
  type RemittanceSnapshot,
  remittanceUnverifiedFormatWarning,
  remittanceUnverifiedIdText,
} from '../../remittance';
import { assertCanSeeRemittances, type TalentActor } from '../policy';
import { dayOf } from '../shared';
import {
  REMITTANCE_REPORT_RECORD_TYPE,
  REMITTANCE_REPORT_SNAPSHOT_SELECT,
  type RemittancePaymentDocument,
  RemittancePaymentModel,
  type RemittanceReportDocument,
  RemittanceReportModel,
} from './model';
import { renderRemittancePdf } from './document';
import { REMITTANCE_NOT_FOUND, REMITTANCE_REPORT_MISSING } from './service';
import { snapshotOfReport } from './snapshot';

// Spec: docs/modules/talent.md#employer-contributions-and-remittances-build-step-211 ("Exports",
// "Upload files", "Audit"; decisions 386–390 in docs/BUILD_PLAN.md), docs/ARCHITECTURE.md#file-
// storage and SECURITY.md#sensitive-data ("Remittances") — a report's PDF, Excel and upload file.
//
// - Whoever may see the report (Talent Read and HR, Accounting or the System Administrator).
// - Refused before anything is written: the upload file for BIR 1601-C (it has none), while a row
//   has no ID, while the employer number is a placeholder, and a report changed since the page
//   loaded.
// - Each press writes and commits an `export` entry on `talent.remittanceReport` (labelled
//   `<agency> · <YYYY-MM>`, the field `pdf`, `xlsx` or `upload`) before the file is rendered or
//   sent. Then the current version's file is reused, or rendered from the snapshot once (the
//   idempotency key `talent.remittance:<report id>:<version>:<format>`), saved with
//   `saveGeneratedFile` (owner `talent.remittanceReport`) and set on the report's `files` once.
//   Opening it goes through the file route, which writes its own `reveal` (`auditView`).
// - The PDF and Excel file come from one `Report` description (the title, the employer's details,
//   the rows and totals, the due date and the flags); amounts are Core's formatted peso text.
// - No entry, log or file name holds an amount or an ID.

/** The file owner type of an exported file (the owner id is the report's id). */
export const REMITTANCE_FILE_TYPE = REMITTANCE_REPORT_RECORD_TYPE;

/** The idempotency key of a version's export (decision 387). */
export const remittanceIdempotencyKey = (
  reportId: string,
  version: number,
  format: RemittanceExportFormat,
) => `talent.remittance:${reportId}:${version}:${format}`;

/** The file route URL of an exported file. */
export const remittanceFileHref = (fileId: string) => `/files/${fileId}`;

const name = (row: Pick<RemittanceRow, 'lastName' | 'firstName' | 'middleName'>) =>
  `${row.lastName}, ${row.firstName}${row.middleName ? ` ${row.middleName}` : ''}`;

/** A row's flags in words, for the Notes column. */
function rowNotes(agency: RemittanceAgency, row: RemittanceRow): string {
  const notes: string[] = [];
  if (row.status === 'newHire' && row.statusDate)
    notes.push(`New hire ${formatDate(row.statusDate)}`);
  if (row.status === 'separated' && row.statusDate) {
    notes.push(`Separated ${formatDate(row.statusDate)}`);
  }
  if (row.flags.differsFromSchedule) notes.push(REMITTANCE_DIFFERS_LABEL);
  if (row.flags.missingId) notes.push(remittanceMissingIdText(agency));
  if (row.flags.unverifiedId) notes.push(remittanceUnverifiedIdText(agency));
  return notes.join('; ');
}

const peso = <Row>(
  header: string,
  value: (row: Row) => Centavos,
  total = true,
  width = 9,
): ReportColumn<Row> => ({ header, kind: 'peso', value, total, width });
const text = <Row>(header: string, value: (row: Row) => string, width = 10): ReportColumn<Row> => ({
  header,
  kind: 'text',
  value,
  width,
});

/** One line of the BIR 1601-C report: an item, a heading, or an employee of the schedule. */
interface BirLine {
  item: string;
  description: string;
  amount: string;
}

const BIR_ITEMS: readonly {
  item: string;
  description: string;
  key: keyof NonNullable<RemittanceSnapshot['totals']['bir']>;
}[] = [
  { item: '14', description: 'Total amount of compensation', key: 'item14' },
  { item: '15', description: 'Statutory minimum wage (minimum wage earners)', key: 'item15' },
  {
    item: '16',
    description: 'Holiday pay, overtime, night differential and hazard pay (minimum wage earners)',
    key: 'item16',
  },
  { item: '17', description: '13th month pay and other benefits', key: 'item17' },
  { item: '18', description: 'De minimis benefits', key: 'item18' },
  {
    item: '19',
    description:
      'SSS, GSIS, PHIC, HDMF mandatory contributions and union dues (employee’s share only)',
    key: 'item19',
  },
  { item: '20', description: 'Other non-taxable compensation', key: 'item20' },
  { item: '21', description: 'Total non-taxable compensation', key: 'item21' },
  { item: '22', description: 'Total taxable compensation', key: 'item22' },
  {
    item: '23',
    description: 'Less: taxable compensation not subject to withholding tax',
    key: 'item23',
  },
  { item: '24', description: 'Net taxable compensation', key: 'item24' },
  { item: '25', description: 'Total taxes withheld', key: 'item25' },
];

/** The BIR 1601-C items as labels and amounts, for the page and the exports. */
export function bir1601cItemLines(
  items: NonNullable<RemittanceSnapshot['totals']['bir']>,
): { item: string; description: string; amountCentavos: Centavos }[] {
  return BIR_ITEMS.map((entry) => ({
    item: entry.item,
    description: entry.description,
    amountCentavos: items[entry.key],
  }));
}

/** The export's description: the Report for the PDF and Excel file, and the PDF's extra lines. */
export interface RemittanceExportDescription {
  report: Report<unknown>;
  headerLines: string[];
  notes: string[];
  rightAligned: Set<number>;
}

/** The status line printed after the table. */
function statusLine(
  snapshot: RemittanceSnapshot,
  payment: Pick<RemittancePaymentDocument, 'paidOn' | 'referenceNumber'> | null,
): string {
  const due = remittanceDueText(snapshot.dueDate);
  return payment
    ? `${due} · ${remittancePaidText(dayOf(payment.paidOn), payment.referenceNumber)}`
    : `${due} · Not paid when this file was made`;
}

/** The report description of a snapshot (see the header). */
export function remittanceExportDescription(
  snapshot: RemittanceSnapshot,
  {
    generatedAt,
    payment = null,
  }: {
    generatedAt: Date;
    payment?: Pick<RemittancePaymentDocument, 'paidOn' | 'referenceNumber'> | null;
  },
): RemittanceExportDescription {
  const { agency, employer, totals } = snapshot;
  const idLabel = REMITTANCE_ID_LABELS[agency].one;
  const headerLines = [
    employer.registeredName,
    employer.businessAddress,
    `${REMITTANCE_EMPLOYER_NUMBER_LABELS[agency].replace(/^company /, 'Company ')}: ${employer.employerNumber}${
      agency === 'bir1601c' ? '' : ` · TIN ${employer.tin}`
    } · RDO ${employer.rdoCode}`,
  ].filter((line) => line.trim() !== '');
  const notes: string[] = [statusLine(snapshot, payment)];
  if (snapshot.goLivePeriods) notes.push(remittanceGoLiveNoteText(snapshot.goLivePeriods));
  if (employer.placeholder) notes.push(remittancePlaceholderWarning(agency));
  const differs = snapshot.rows.filter((row) => row.flags.differsFromSchedule).length;
  if (differs > 0) {
    notes.push(
      `${differs} ${differs === 1 ? 'row differs' : 'rows differ'} from the schedule: each equals what the runs deducted.`,
    );
  }
  const subtitleParts = [headerLines.join(' · '), `${remittanceDueText(snapshot.dueDate)}`];
  if (employer.placeholder) subtitleParts.push(remittancePlaceholderWarning(agency));
  if (snapshot.goLivePeriods) subtitleParts.push(remittanceGoLiveNoteText(snapshot.goLivePeriods));
  const base = {
    title: remittanceExportTitle(agency, snapshot.month),
    subtitle: subtitleParts.join(' · '),
    generatedAt,
  };

  switch (agency) {
    case 'sss': {
      const columns: ReportColumn<RemittanceRow>[] = [
        text('Employee no.', (row) => row.employeeNumber, 9),
        text('Name', name, 16),
        text(idLabel, (row) => row.idNumber ?? '', 10),
        peso('Salary credit', (row) => row.basisCentavos, false),
        peso('EE regular SS', (row) => row.employee.regularCentavos),
        peso('EE MPF', (row) => row.employee.mpfCentavos),
        peso('EE total', (row) => row.employee.totalCentavos),
        peso('ER regular SS', (row) => row.employer.regularCentavos),
        peso('ER MPF', (row) => row.employer.mpfCentavos),
        peso('ER total', (row) => row.employer.totalCentavos),
        peso('EC', (row) => row.ecCentavos, true, 7),
        peso('Total', (row) => row.totalCentavos),
        text('Notes', (row) => rowNotes(agency, row), 14),
      ];
      notes.push(`Amount due ${formatPeso(totals.amountDueCentavos)}: employee, employer and EC.`);
      return {
        report: { ...base, columns, rows: snapshot.rows } as Report<unknown>,
        headerLines,
        notes,
        rightAligned: new Set(),
      };
    }
    case 'philhealth': {
      const columns: ReportColumn<RemittanceRow>[] = [
        text('Employee no.', (row) => row.employeeNumber, 9),
        text('Name', name, 16),
        text(idLabel, (row) => row.idNumber ?? '', 11),
        text('Date of birth', (row) => (row.dateOfBirth ? formatDate(row.dateOfBirth) : ''), 9),
        text('Sex', (row) => (row.sex === 'male' ? 'M' : row.sex === 'female' ? 'F' : ''), 4),
        peso('Monthly basic salary', (row) => row.basisCentavos, false, 11),
        peso('PS', (row) => row.employee.totalCentavos),
        peso('ES', (row) => row.employer.totalCentavos),
        peso('Total', (row) => row.totalCentavos),
        text('Notes', (row) => rowNotes(agency, row), 14),
      ];
      notes.push(`Amount due ${formatPeso(totals.amountDueCentavos)}: PS and ES.`);
      return {
        report: { ...base, columns, rows: snapshot.rows } as Report<unknown>,
        headerLines,
        notes,
        rightAligned: new Set(),
      };
    }
    case 'pagibig': {
      const columns: ReportColumn<RemittanceRow>[] = [
        text('Employee no.', (row) => row.employeeNumber, 9),
        text('Name', name, 16),
        text(idLabel, (row) => row.idNumber ?? '', 11),
        peso('Monthly compensation', (row) => row.basisCentavos, false, 11),
        peso('Employee share', (row) => row.employee.totalCentavos),
        peso('Employer share', (row) => row.employer.totalCentavos),
        peso('Total', (row) => row.totalCentavos),
        text('Notes', (row) => rowNotes(agency, row), 14),
      ];
      notes.push(
        `Amount due ${formatPeso(totals.amountDueCentavos)}: employee and employer shares.`,
      );
      return {
        report: { ...base, columns, rows: snapshot.rows } as Report<unknown>,
        headerLines,
        notes,
        rightAligned: new Set(),
      };
    }
    case 'bir1601c': {
      const items = totals.bir;
      const lines: BirLine[] = items
        ? bir1601cItemLines(items).map((entry) => ({
            item: `Item ${entry.item}`,
            description: entry.description,
            amount: formatPeso(entry.amountCentavos),
          }))
        : [];
      lines.push({
        item: 'Items 26–35',
        description: 'Adjustments, previous remittances and penalties',
        amount: REMITTANCE_BIR_ADJUSTMENTS_TEXT,
      });
      lines.push({ item: '', description: 'Per-employee schedule', amount: 'Tax withheld' });
      for (const row of snapshot.rows) {
        const bir = row.bir;
        const parts = [
          name(row),
          `TIN ${row.idNumber ?? '—'}`,
          ...(row.minimumWageEarner ? ['Minimum wage earner'] : []),
          ...(bir
            ? [
                `compensation ${formatPeso(bir.totalCompensationCentavos)}`,
                `non-taxable ${formatPeso(bir.nonTaxableCentavos)}`,
                `taxable ${formatPeso(bir.taxableCentavos)}`,
              ]
            : []),
          ...(rowNotes(agency, row) ? [rowNotes(agency, row)] : []),
        ];
        lines.push({
          item: row.employeeNumber,
          description: parts.join(' · '),
          amount: formatPeso(row.totalCentavos),
        });
      }
      const columns: ReportColumn<BirLine>[] = [
        text('Item or employee no.', (line) => line.item, 8),
        text('Description', (line) => line.description, 40),
        text('Amount', (line) => line.amount, 10),
      ];
      if (items && items.item22DifferenceCentavos !== 0) {
        notes.push(
          `Item 22 differs from the runs’ taxable compensation by ${formatPeso(items.item22DifferenceCentavos)}.`,
        );
      }
      notes.push(REMITTANCE_BIR_NO_UPLOAD_TEXT);
      return {
        report: { ...base, columns, rows: lines } as Report<unknown>,
        headerLines,
        notes,
        rightAligned: new Set([2]),
      };
    }
  }
}

// ---------------------------------------------------------------------------------------------
// The export action

export interface ExportRemittanceInput {
  agency: unknown;
  month: unknown;
  format: unknown;
  /** The report's version the page shows. */
  version: unknown;
}

export interface ExportedRemittance {
  fileId: string;
  href: string;
  fileName: string;
}

type ExportReport = RemittanceReportDocument;

function isExportFormat(value: unknown): value is RemittanceExportFormat {
  return (
    typeof value === 'string' && (REMITTANCE_EXPORT_FORMATS as readonly string[]).includes(value)
  );
}

/** Renders one format of the snapshot: its bytes, content type and file name. */
async function renderFormat(
  report: ExportReport,
  snapshot: RemittanceSnapshot,
  format: RemittanceExportFormat,
): Promise<{ bytes: Uint8Array; contentType: string; fileName: string }> {
  const payment = report.paymentId
    ? await RemittancePaymentModel.findById(report.paymentId, {
        paidOn: 1,
        referenceNumber: 1,
      }).lean<Pick<RemittancePaymentDocument, 'paidOn' | 'referenceNumber'>>()
    : null;
  const description = remittanceExportDescription(snapshot, {
    generatedAt: new Date(),
    payment: report.status === 'paid' ? payment : null,
  });
  switch (format) {
    case 'pdf':
      return {
        bytes: await renderRemittancePdf(description),
        contentType: PDF_CONTENT_TYPE,
        fileName: remittanceFileName(report.agency, report.month, 'pdf'),
      };
    case 'xlsx':
      return {
        bytes: await buildReportWorkbook(description.report),
        contentType: XLSX_CONTENT_TYPE,
        fileName: remittanceFileName(report.agency, report.month, 'xlsx'),
      };
    case 'upload': {
      const definition = remittanceFormatById(report.formatId);
      if (!definition) throw new ActionError(REMITTANCE_BIR_NO_UPLOAD_TEXT);
      return {
        bytes: new TextEncoder().encode(definition.build(snapshot)),
        contentType: definition.contentType,
        fileName: remittanceFileName(report.agency, report.month, definition.extension),
      };
    }
  }
}

/**
 * "PDF", "Excel" or "Upload file" on a report (see the header). Answers the file's route URL.
 */
export async function exportRemittanceReport(
  actor: TalentActor,
  input: ExportRemittanceInput,
): Promise<ExportedRemittance> {
  assertCanSeeRemittances(actor);
  const { agency, month, format } = input;
  if (!isRemittanceAgency(agency) || !isRemittanceMonth(month) || !isExportFormat(format)) {
    throw new ActionError(REMITTANCE_NOT_FOUND);
  }
  const version = Number(input.version);
  await connectDb();
  const report = await RemittanceReportModel.findOne({ agency, month }).lean<
    Omit<ExportReport, 'rows' | 'totals'>
  >();
  if (!report) throw new ActionError(REMITTANCE_REPORT_MISSING);
  if (!Number.isSafeInteger(version) || report.version !== version) {
    throw new ActionError(REMITTANCE_REPORT_CHANGED_MESSAGE);
  }
  if (format === 'upload') {
    if (!hasRemittanceUpload(agency)) throw new ActionError(REMITTANCE_BIR_NO_UPLOAD_TEXT);
    if (report.flagCounts.missingId > 0) {
      throw new ActionError(remittanceMissingIdsRefusal(agency, report.flagCounts.missingId));
    }
    if (report.employer.placeholder) throw new ActionError(remittancePlaceholderRefusal(agency));
  }

  // The `export` entry is committed before anything is rendered or sent, on every press.
  await recordAudit({
    actorId: actor.id,
    actorEmail: actor.email,
    module: 'talent',
    action: 'export',
    record: {
      type: REMITTANCE_REPORT_RECORD_TYPE,
      id: report._id,
      label: remittanceAuditLabel(agency, month),
    },
    before: null,
    after: null,
    fields: [format],
  });

  const fileOf = (id: Types.ObjectId) => ({
    fileId: id.toHexString(),
    href: remittanceFileHref(id.toHexString()),
  });
  const existingFile = report.files?.[format] ?? null;
  if (existingFile) {
    return {
      ...fileOf(existingFile),
      fileName: remittanceFileName(
        agency,
        month,
        format === 'upload' ? (remittanceFormatById(report.formatId)?.extension ?? 'txt') : format,
      ),
    };
  }

  const full = await RemittanceReportModel.findOne({ _id: report._id, version })
    .select(REMITTANCE_REPORT_SNAPSHOT_SELECT)
    .lean<ExportReport>();
  if (!full) throw new ActionError(REMITTANCE_REPORT_CHANGED_MESSAGE);
  const snapshot = await snapshotOfReport(full);
  const rendered = await renderFormat(full, snapshot, format);
  const reportId = full._id.toHexString();
  const file = await saveGeneratedFile({
    bytes: rendered.bytes,
    contentType: rendered.contentType as Parameters<typeof saveGeneratedFile>[0]['contentType'],
    fileName: rendered.fileName,
    owner: { type: REMITTANCE_FILE_TYPE, id: full._id },
    actorId: new Types.ObjectId(actor.id),
    idempotencyKey: remittanceIdempotencyKey(reportId, version, format),
  });
  const fileId = new Types.ObjectId(file.id);
  const path = `files.${format}`;
  await RemittanceReportModel.updateOne(
    { _id: full._id, version, [path]: null },
    { $set: { [path]: fileId, updatedBy: new Types.ObjectId(actor.id) } },
  );
  const after = await RemittanceReportModel.findById(full._id, { version: 1, files: 1 }).lean<
    Pick<ExportReport, 'version' | 'files'>
  >();
  const current = after?.files?.[format] ?? null;
  if (!after || after.version !== version || !current) {
    throw new ActionError(REMITTANCE_REPORT_CHANGED_MESSAGE);
  }
  // A second press that raced this one set the same file (the idempotency key).
  return { ...fileOf(current), fileName: rendered.fileName };
}

/** The upload sheet's warning for a format id, or null once verified. */
export function remittanceUploadWarning(agency: RemittanceAgency, formatId: string | null) {
  const format = remittanceFormatById(formatId);
  return format && !format.verified ? remittanceUnverifiedFormatWarning(agency) : null;
}
