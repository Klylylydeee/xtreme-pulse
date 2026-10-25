import { type Query, Schema, type Types, type UpdateQuery } from 'mongoose';
import { baseSchemaPlugin, defineModel } from '@pulse/db';
import { guardWrites, hasOnlyKeys, sensitiveField } from '@pulse/core/server';
import {
  REMITTANCE_AGENCIES,
  REMITTANCE_EXPORT_FORMATS,
  REMITTANCE_REPORT_STATUSES,
  type RemittanceAgency,
  type RemittanceExportFormat,
  type RemittanceReportStatus,
} from '../../remittance/agencies';

// Spec: docs/DATA_MODEL.md#collection-ownership (`remittanceReports`, `remittancePayments`, build
// step 2.11), docs/modules/talent.md#employer-contributions-and-remittances-build-step-211
// ("Reports", "Payments") and SECURITY.md#sensitive-data ("Remittances"; decisions 385, 387, 391,
// 392 and 395 in docs/BUILD_PLAN.md).
//
// - `remittanceReports`: one per agency and month (unique), inserted when first generated, never
//   deleted. The snapshot's `rows` and `totals` are `sensitiveField()`s (category `payslip`), one
//   encrypted JSON string each (the rows hold every employee's government ID number inside); the
//   counts, the flag counts, the source runs, the employer's details (company data), the setting
//   versions, the due date and the format id are plain. The write guard allows exactly these
//   `updateOne` / `findOneAndUpdate` shapes, `$set` (and `$inc` for a regenerate) only:
//   - a regenerate: filtered on `status: 'generated'`, `$set` of the snapshot fields with `files`
//     reset to nulls, `$inc` of `version` by 1;
//   - one export file: filtered on `files.<format>: null` and `version`, `$set` of that
//     `files.<format>` only (no `$inc`);
//   - marking paid: filtered on `status: 'generated'` and `version`, `$set` of `status: 'paid'`
//     and `paymentId` (no `$inc`);
//   - a correction: filtered on `status: 'paid'`, `$set` of `paymentId` only;
//   - a void: filtered on `status: 'paid'`, `$set` of `status: 'generated'` and `paymentId: null`.
//   Every other write (a replace, a delete, an upsert, `updateMany`, a save of a loaded document,
//   a `bulkWrite` that isn't inserts) is refused.
// - `remittancePayments`: insert-only (`guardWrites`). Partial unique indexes allow one first
//   entry (`supersedesId` null) per report and one entry per `supersedesId`, so a correction, a
//   void or a payment recorded again after a void supersedes the latest of the one chain. The
//   amount is a `sensitiveField()` (category `payslip`); the date, reference and note are plain.
//   `fiscalDisbursement` is `{ status: 'notRecorded' }` until step 5.8.
// - Both get the `$jsonSchema` validator for their sensitive paths when their indexes are built
//   (ADR 0012). Written only by Talent's remittance service.

/** The audit record types (decision 390 and 391). */
export const REMITTANCE_REPORT_RECORD_TYPE = 'talent.remittanceReport';
export const REMITTANCE_PAYMENT_RECORD_TYPE = 'talent.remittancePayment';

/** A payment's reference number: 1 to 60 characters, plain. */
export const REMITTANCE_REFERENCE_MAX_LENGTH = 60;
/** A payment's optional note: up to 300 characters, plain. */
export const REMITTANCE_NOTE_MAX_LENGTH = 300;
/** A correction's or void's reason: 1 to 300 characters. */
export const REMITTANCE_REASON_MAX_LENGTH = 300;

/** A payment's Fiscal disbursement status: `notRecorded` in step 2.11; step 5.8 adds `recorded`. */
export const REMITTANCE_FISCAL_DISBURSEMENT_STATUSES = ['notRecorded'] as const;
export type RemittanceFiscalDisbursementStatus =
  (typeof REMITTANCE_FISCAL_DISBURSEMENT_STATUSES)[number];

const MONTH_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;
const RUN_NUMBER_PATTERN = /^PAY-\d{4}-\d{4,}$/;
const BUSINESS_DATE_PATTERN = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

const wholeNumber = (min: number) => ({
  validator: (value: number) => Number.isSafeInteger(value) && value >= min,
  message: `A whole number of at least ${min} is required.`,
});

// ---------------------------------------------------------------------------------------------
// remittanceReports

export interface RemittanceSourceRunRef {
  runId: Types.ObjectId;
  number: string;
  /** 00:00 Manila on each day, stored in UTC. */
  periodStart: Date;
  periodEnd: Date;
}

export interface RemittanceReportFlagCounts {
  differsFromSchedule: number;
  missingId: number;
  unverifiedId: number;
}

export interface RemittanceReportEmployer {
  registeredName: string;
  businessAddress: string;
  tin: string;
  rdoCode: string;
  employerNumber: string;
  placeholder: boolean;
}

export interface RemittanceSettingVersionRef {
  key: string;
  /** The version's effective date, or null for the built-in seed (no version stored). */
  effectiveFrom: string | null;
}

export interface RemittanceReportFiles {
  pdf: Types.ObjectId | null;
  xlsx: Types.ObjectId | null;
  upload: Types.ObjectId | null;
}

export interface RemittanceReportDocument {
  _id: Types.ObjectId;
  agency: RemittanceAgency;
  /** `YYYY-MM`, the contribution month. */
  month: string;
  status: RemittanceReportStatus;
  /** Raised by each regenerate. */
  version: number;
  generatedAt: Date;
  generatedBy: Types.ObjectId | null;
  sourceRuns: RemittanceSourceRunRef[];
  /** The cut-offs paid before go-live ("Sep 26 – Oct 10, 2026"), or null. */
  goLiveNote: string | null;
  employeeCount: number;
  flagCounts: RemittanceReportFlagCounts;
  employer: RemittanceReportEmployer;
  settingVersions: RemittanceSettingVersionRef[];
  /** 00:00 Manila on the due day. */
  dueDate: Date;
  /** The upload format definition, or null for BIR 1601-C. */
  formatId: string | null;
  /** The encrypted rows: one JSON string with `rowsVersion` 1 (category `payslip`). */
  rows: Buffer;
  /** The encrypted totals: one JSON string (category `payslip`). */
  totals: Buffer;
  /** The current version's exported files. */
  files: RemittanceReportFiles;
  /** The live payment, or null. */
  paymentId: Types.ObjectId | null;
  createdAt: Date;
  updatedAt: Date;
  createdBy: Types.ObjectId | null;
  updatedBy: Types.ObjectId | null;
}

/** Selects the snapshot's encrypted fields: `.select(REMITTANCE_REPORT_SNAPSHOT_SELECT)`. */
export const REMITTANCE_REPORT_SNAPSHOT_SELECT = '+rows +totals';

const sourceRunSchema = new Schema<RemittanceSourceRunRef>(
  {
    runId: { type: Schema.Types.ObjectId, required: true },
    number: { type: String, required: true, match: RUN_NUMBER_PATTERN },
    periodStart: { type: Date, required: true },
    periodEnd: { type: Date, required: true },
  },
  { _id: false },
);

const flagCountsSchema = new Schema<RemittanceReportFlagCounts>(
  {
    differsFromSchedule: { type: Number, required: true, default: 0, validate: wholeNumber(0) },
    missingId: { type: Number, required: true, default: 0, validate: wholeNumber(0) },
    unverifiedId: { type: Number, required: true, default: 0, validate: wholeNumber(0) },
  },
  { _id: false },
);

const employerText = (max: number) => ({ type: String, default: '', trim: true, maxlength: max });

const employerSchema = new Schema<RemittanceReportEmployer>(
  {
    registeredName: employerText(300),
    businessAddress: employerText(500),
    tin: employerText(100),
    rdoCode: employerText(100),
    employerNumber: employerText(100),
    placeholder: { type: Boolean, required: true },
  },
  { _id: false },
);

const settingVersionSchema = new Schema<RemittanceSettingVersionRef>(
  {
    key: { type: String, required: true, trim: true, minlength: 1, maxlength: 100 },
    effectiveFrom: { type: String, default: null, match: BUSINESS_DATE_PATTERN },
  },
  { _id: false },
);

const filesSchema = new Schema<RemittanceReportFiles>(
  {
    pdf: { type: Schema.Types.ObjectId, default: null },
    xlsx: { type: Schema.Types.ObjectId, default: null },
    upload: { type: Schema.Types.ObjectId, default: null },
  },
  { _id: false },
);

const remittanceReportSchema = new Schema<RemittanceReportDocument>({
  agency: { type: String, enum: REMITTANCE_AGENCIES, required: true, immutable: true },
  month: { type: String, required: true, immutable: true, match: MONTH_PATTERN },
  status: { type: String, enum: REMITTANCE_REPORT_STATUSES, required: true, default: 'generated' },
  version: { type: Number, required: true, default: 1, validate: wholeNumber(1) },
  generatedAt: { type: Date, required: true },
  generatedBy: { type: Schema.Types.ObjectId, default: null },
  sourceRuns: { type: [sourceRunSchema], default: [] },
  goLiveNote: { type: String, default: null, trim: true, maxlength: 500 },
  employeeCount: { type: Number, required: true, validate: wholeNumber(0) },
  flagCounts: { type: flagCountsSchema, default: () => ({}) },
  employer: { type: employerSchema, required: true },
  settingVersions: { type: [settingVersionSchema], default: [] },
  dueDate: { type: Date, required: true },
  formatId: { type: String, default: null, trim: true, maxlength: 100 },
  rows: sensitiveField({ required: true }),
  totals: sensitiveField({ required: true }),
  files: { type: filesSchema, default: () => ({}) },
  paymentId: { type: Schema.Types.ObjectId, default: null },
});

/** One report per agency and month. */
export const ONE_REPORT_PER_AGENCY_MONTH_INDEX = 'oneRemittanceReportPerAgencyMonth';
remittanceReportSchema.index(
  { agency: 1, month: 1 },
  { unique: true, name: ONE_REPORT_PER_AGENCY_MONTH_INDEX },
);
remittanceReportSchema.index({ month: 1 });

const REPORT_GUARD_MESSAGE =
  'A remittance report is never deleted. It changes only through the remittance service: regenerated while not paid, its export files set once per version, marked paid, its payment corrected, or its payment voided.';

/** The base fields every update may set (the timestamps plugin's). */
const BASE_SET_KEYS = ['updatedAt', 'updatedBy'];
/** The snapshot fields a regenerate replaces. */
export const REMITTANCE_SNAPSHOT_KEYS = [
  'generatedAt',
  'generatedBy',
  'sourceRuns',
  'goLiveNote',
  'employeeCount',
  'flagCounts',
  'employer',
  'settingVersions',
  'dueDate',
  'formatId',
  'rows',
  'totals',
] as const;
const REGENERATE_SET_KEYS = new Set<string>([
  ...REMITTANCE_SNAPSHOT_KEYS,
  'files',
  ...BASE_SET_KEYS,
]);
const MARK_PAID_SET_KEYS = new Set<string>(['status', 'paymentId', ...BASE_SET_KEYS]);
const CORRECTION_SET_KEYS = new Set<string>(['paymentId', ...BASE_SET_KEYS]);
const VOID_SET_KEYS = MARK_PAID_SET_KEYS;
const FILE_SET_KEYS = Object.fromEntries(
  REMITTANCE_EXPORT_FORMATS.map((format) => [
    format,
    new Set<string>([`files.${format}`, ...BASE_SET_KEYS]),
  ]),
) as Record<RemittanceExportFormat, Set<string>>;

const present = (value: unknown) => value !== undefined && value !== null;
const isVersion = (value: unknown) => Number.isSafeInteger(value) && (value as number) >= 1;

/** True for a `files` reset: `{ pdf: null, xlsx: null, upload: null }` exactly. */
function isFilesReset(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false;
  const files = value as Record<string, unknown>;
  return (
    hasOnlyKeys(files, new Set(REMITTANCE_EXPORT_FORMATS)) &&
    REMITTANCE_EXPORT_FORMATS.every((format) => files[format] === null)
  );
}

/** True for one of the report updates in the header; see there. */
function isAllowedReportUpdate(
  update: UpdateQuery<unknown>,
  query: Query<unknown, unknown>,
): boolean {
  if (Array.isArray(update) || Object.keys(update).length === 0) return false;
  const options = query.getOptions();
  if (options.upsert === true || options.overwrite === true) return false;
  if (!hasOnlyKeys(update, new Set(['$set', '$inc']))) return false;
  const set = update.$set as Record<string, unknown> | undefined;
  const inc = update.$inc as Record<string, unknown> | undefined;
  if (typeof set !== 'object' || set === null) return false;
  const filter = query.getFilter();
  const status: unknown = filter.status;

  // A regenerate: the whole snapshot, the files reset, the version raised.
  if (inc !== undefined) {
    return (
      status === 'generated' &&
      hasOnlyKeys(inc, new Set(['version', '__v'])) &&
      inc.version === 1 &&
      hasOnlyKeys(set, REGENERATE_SET_KEYS) &&
      REMITTANCE_SNAPSHOT_KEYS.every((key) => key in set) &&
      isFilesReset(set.files)
    );
  }
  // One export file, once per version.
  for (const format of REMITTANCE_EXPORT_FORMATS) {
    const path = `files.${format}`;
    if (path in set) {
      return (
        hasOnlyKeys(set, FILE_SET_KEYS[format]) &&
        present(set[path]) &&
        path in filter &&
        filter[path] === null &&
        isVersion(filter.version)
      );
    }
  }
  switch (set.status) {
    case 'paid':
      return (
        status === 'generated' &&
        isVersion(filter.version) &&
        hasOnlyKeys(set, MARK_PAID_SET_KEYS) &&
        present(set.paymentId)
      );
    case 'generated':
      return status === 'paid' && hasOnlyKeys(set, VOID_SET_KEYS) && set.paymentId === null;
    case undefined:
      return status === 'paid' && hasOnlyKeys(set, CORRECTION_SET_KEYS) && present(set.paymentId);
    default:
      return false;
  }
}

guardWrites(remittanceReportSchema, {
  message: REPORT_GUARD_MESSAGE,
  allowUpdate: (update, query) => isAllowedReportUpdate(update, query),
});

// Never deleted, so no soft delete either.
remittanceReportSchema.plugin(baseSchemaPlugin, { softDelete: false });

export const RemittanceReportModel = defineModel(
  'RemittanceReport',
  remittanceReportSchema,
  'remittanceReports',
);

// ---------------------------------------------------------------------------------------------
// remittancePayments

export interface RemittanceFiscalDisbursement {
  status: RemittanceFiscalDisbursementStatus;
}

export interface RemittancePaymentDocument {
  _id: Types.ObjectId;
  reportId: Types.ObjectId;
  agency: RemittanceAgency;
  month: string;
  /** The report's version the payment was recorded against. */
  reportVersion: number;
  /** 00:00 Manila on the paid day. */
  paidOn: Date;
  /** The PRN, the eFPS or eBIRForms confirmation, or the bank's reference: 1–60, plain. */
  referenceNumber: string;
  /** The encrypted whole number of centavos, 1 or more (category `payslip`). */
  amountCentavos?: Buffer;
  /** Up to 300 characters, or null. Plain: the sheet says not to type amounts or IDs in it. */
  note: string | null;
  /** The entry this one corrects or voids (or the void a new payment follows), or null. */
  supersedesId: Types.ObjectId | null;
  /** True on a void. */
  voided: boolean;
  /** A correction's or void's reason (1–300), else null. */
  reason: string | null;
  fiscalDisbursement: RemittanceFiscalDisbursement;
  createdAt: Date;
  updatedAt: Date;
  createdBy: Types.ObjectId | null;
  updatedBy: Types.ObjectId | null;
}

/** Selects the payment's encrypted amount: `.select(REMITTANCE_PAYMENT_AMOUNT_SELECT)`. */
export const REMITTANCE_PAYMENT_AMOUNT_SELECT = '+amountCentavos';

const fiscalDisbursementSchema = new Schema<RemittanceFiscalDisbursement>(
  {
    status: {
      type: String,
      enum: REMITTANCE_FISCAL_DISBURSEMENT_STATUSES,
      required: true,
      default: 'notRecorded',
    },
  },
  { _id: false },
);

const remittancePaymentSchema = new Schema<RemittancePaymentDocument>({
  reportId: { type: Schema.Types.ObjectId, required: true, immutable: true },
  agency: { type: String, enum: REMITTANCE_AGENCIES, required: true, immutable: true },
  month: { type: String, required: true, immutable: true, match: MONTH_PATTERN },
  reportVersion: { type: Number, required: true, immutable: true, validate: wholeNumber(1) },
  paidOn: { type: Date, required: true, immutable: true },
  referenceNumber: {
    type: String,
    required: true,
    trim: true,
    minlength: 1,
    maxlength: REMITTANCE_REFERENCE_MAX_LENGTH,
    immutable: true,
  },
  amountCentavos: sensitiveField(),
  note: {
    type: String,
    default: null,
    trim: true,
    maxlength: REMITTANCE_NOTE_MAX_LENGTH,
    immutable: true,
  },
  supersedesId: { type: Schema.Types.ObjectId, default: null, immutable: true },
  voided: { type: Boolean, required: true, default: false, immutable: true },
  reason: {
    type: String,
    default: null,
    trim: true,
    minlength: 1,
    maxlength: REMITTANCE_REASON_MAX_LENGTH,
    immutable: true,
  },
  fiscalDisbursement: {
    type: fiscalDisbursementSchema,
    default: () => ({ status: 'notRecorded' }),
  },
});

remittancePaymentSchema.pre('validate', function () {
  if (!this.isNew) return;
  // A correction or void needs a reason and the entry it supersedes; a first payment has neither.
  if ((this.voided || this.reason !== null) && this.supersedesId === null) {
    this.invalidate('supersedesId', 'A correction or void supersedes the entry it changes.');
  }
  if (this.voided && (this.reason === null || this.reason.trim() === '')) {
    this.invalidate('reason', 'A void needs a reason.');
  }
  if (!this.voided && this.amountCentavos === undefined) {
    this.invalidate('amountCentavos', 'A payment needs an amount.');
  }
});

remittancePaymentSchema.index({ reportId: 1, createdAt: -1 });
/** One first entry per report. */
export const ONE_FIRST_PAYMENT_PER_REPORT_INDEX = 'oneFirstRemittancePaymentPerReport';
remittancePaymentSchema.index(
  { reportId: 1 },
  {
    unique: true,
    name: ONE_FIRST_PAYMENT_PER_REPORT_INDEX,
    partialFilterExpression: { supersedesId: { $type: 'null' } },
  },
);
/** One entry per superseded entry: every later entry supersedes the latest of the chain. */
export const ONE_PAYMENT_PER_SUPERSEDED_INDEX = 'oneRemittancePaymentPerSuperseded';
remittancePaymentSchema.index(
  { supersedesId: 1 },
  {
    unique: true,
    name: ONE_PAYMENT_PER_SUPERSEDED_INDEX,
    partialFilterExpression: { supersedesId: { $type: 'objectId' } },
  },
);

guardWrites(remittancePaymentSchema, {
  message:
    'Remittance payments are never changed or deleted. Correct or void a payment with a new entry that supersedes the latest one.',
});

remittancePaymentSchema.plugin(baseSchemaPlugin, { softDelete: false });

export const RemittancePaymentModel = defineModel(
  'RemittancePayment',
  remittancePaymentSchema,
  'remittancePayments',
);
