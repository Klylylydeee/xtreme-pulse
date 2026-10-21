import { type ClientSession, type Query, Schema, Types, type UpdateQuery } from 'mongoose';
import { baseSchemaPlugin, defineModel } from '@pulse/db';
import { hasOnlyKeys, sensitiveField } from '@pulse/core/server';
import { PAYROLL_BANKS, type PayrollBank } from '../../fixed-sets';
import { CUT_OFF_KEYS, type CutOffKey } from '../../payroll/schemas';
import { TIMESHEET_STATUSES, type TimesheetStatus } from '../../timesheets/schemas';

// Spec: docs/DATA_MODEL.md#collection-ownership (`payrollRuns`, `payrollRunEmployees`, build steps
// 2.9 and 2.10), docs/modules/talent.md#payroll-run-computation-build-step-29 ("Payroll runs",
// "The employee line", "Recomputing a draft"),
// docs/modules/talent.md#payroll-review-approval-and-payslips-build-step-210 ("Statuses", "Review
// flags", "Write guards") and SECURITY.md#sensitive-data (decisions 327, 340, 341, 343 and 371–372
// in docs/BUILD_PLAN.md).
//
// - `payrollRuns`: one regular run per cut-off (unique `{ kind, periodStart }`), numbered
//   `PAY-YYYY-NNNN` with the pay date's year when it is created. Never deleted. The run's totals
//   are a subdocument of `sensitiveField()`s (category `payslip`), encrypted with
//   `encryptSensitive`; the counts, the dates, the flags' summary and the people left out are plain.
// - The run guard (decision 371) lets a run change only by one of these `updateOne` /
//   `findOneAndUpdate` shapes, each using only `$set` and `$inc`:
//   - a recompute: filtered on `status` `draft` or `returned`, `$set` of the recompute's fields and
//     `flagCounts`, `$inc` of `version`;
//   - submit: filtered on `draft` or `returned`, `$set` of `status: 'pendingApproval'`,
//     `submittedAt`, `submittedBy` and `approvalRequestId`, `$inc` of `version`;
//   - return: filtered on `pendingApproval`, `$set` of `status: 'returned'`, `returnedAt`,
//     `returnedBy` and `returnRemarks` (1–1,000), `$inc` of `version`;
//   - finalize: filtered on `pendingApproval`, `$set` of `status: 'finalized'`, `finalizedAt`,
//     `finalizedBy`, `fiscalPosting: { status: 'notPosted' }` and `payslipsPending: true`, `$inc` of
//     `version`;
//   - on a `finalized` run, `$set` of `payslipsPending: false` only (no `$inc`).
//   Every other write is refused, so a pending run is frozen and a finalized run never changes
//   (step 5.8 widens it for `fiscalPosting`). The fixed fields are immutable.
// - `payrollRunEmployees`: one line per employee in a run (unique `{ runId, employeeId }`). The
//   line's breakdown (one JSON string, `breakdownVersion` 1 or 2) and its gross, deductions, net pay
//   and reimbursements are `sensitiveField()`s (category `payslip`). The flags and the manual entry
//   count are plain. An editable (`draft` or `returned`) run's lines are replaced as a set on each
//   recompute: the guard lets through only inserts of lines for an editable run (`bulkWrite`
//   `insertOne` operations or `create()`; `insertMany` is refused, since its middleware can't see
//   the session), and a `deleteMany({ runId })` of an editable run's lines, each checked against
//   the run in the write's session. After that a line changes twice at most: the finalize hook sets
//   its `payslip` snapshot once (filtered on `runId` and `payslip: null`, the run `pendingApproval`
//   in the write's session; `updateOne`, `findOneAndUpdate` or `bulkWrite` `updateOne` operations),
//   and the PDF step sets `payslip.fileId` and `payslip.generatedAt` once (filtered on `runId` and
//   `payslip.fileId: null`, the run `finalized`). Every other write is refused.
// - Both collections get the `$jsonSchema` validator for their sensitive paths when their indexes
//   are built (ADR 0012), the payslip's account number and year-to-date included. Written only by
//   Talent's payroll run and review services.
//
// The kind, status and flag lists match `PAYROLL_RUN_KINDS`, `PAYROLL_RUN_STATUSES` and the flag
// kinds of the pure pay engine (../../payroll-run/); the services may import those instead.

/** The audit record type of a run, and the reveal owner type of a line. */
export const PAYROLL_RUN_RECORD_TYPE = 'talent.payrollRun';
export const PAYROLL_RUN_EMPLOYEE_RECORD_TYPE = 'talent.payrollRunEmployee';

/** `kind`: `regular` (step 2.9); `thirteenthMonth` from step 2.12. */
const RUN_KINDS = ['regular', 'thirteenthMonth'] as const;
export type PayrollRunModelKind = (typeof RUN_KINDS)[number];
/** `status`: step 2.9 writes `draft`; step 2.10 the rest. */
const RUN_STATUSES = ['draft', 'pendingApproval', 'returned', 'finalized'] as const;
export type PayrollRunModelStatus = (typeof RUN_STATUSES)[number];
/** The statuses a run is edited in (recomputed, manual entries, acknowledgements): decision 351. */
export const PAYROLL_RUN_EDITABLE_STATUSES = [
  'draft',
  'returned',
] as const satisfies readonly PayrollRunModelStatus[];
export type PayrollRunEditableStatus = (typeof PAYROLL_RUN_EDITABLE_STATUSES)[number];
/** Why an employee is left out of a run. */
const LEFT_OUT_REASONS = ['noSalary'] as const;
export type PayrollRunLeftOutReason = (typeof LEFT_OUT_REASONS)[number];

/** The review flags a line can carry (decision 352), in the order the run page shows them. */
export const PAYROLL_LINE_FLAG_KINDS = [
  'onboardingIncomplete',
  'timesheetNotApproved',
  'belowMinimumWage',
  'netPayBelowZero',
  'manualEntryStale',
] as const;
export type PayrollLineFlagKind = (typeof PAYROLL_LINE_FLAG_KINDS)[number];

/** A finalized run's Fiscal posting status: `notPosted` in step 2.10; step 5.8 adds `posted`. */
export const PAYROLL_FISCAL_POSTING_STATUSES = ['notPosted'] as const;
export type PayrollFiscalPostingStatus = (typeof PAYROLL_FISCAL_POSTING_STATUSES)[number];

/** A Board member's remarks when returning a run: 1 to 1,000 characters. */
export const PAYROLL_RUN_RETURN_REMARKS_MAX_LENGTH = 1000;

/** `PAY-2026-0001`: the prefix, the pay date's year and Core's counter. */
export const PAYROLL_RUN_NUMBER_PATTERN = /^PAY-\d{4}-\d{4,}$/;
const CONTRIBUTION_MONTH_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;
const BUSINESS_DATE_PATTERN = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

const wholeNumber = (min: number) => ({
  validator: (value: number) => Number.isSafeInteger(value) && value >= min,
  message: `A whole number of at least ${min} is required.`,
});

// ---------------------------------------------------------------------------------------------
// payrollRuns

/** One setting version a run used: its key and the effective date of the version applied. */
export interface PayrollRunSettingVersion {
  key: string;
  /** The version's effective date, or null when no version was stored (the built-in seed). */
  effectiveFrom: string | null;
}

export interface PayrollRunLeftOut {
  employeeId: Types.ObjectId;
  reason: PayrollRunLeftOutReason;
}

/** The run's totals, each the encrypted whole number of centavos (category `payslip`). */
export interface PayrollRunTotals {
  grossCentavos: Buffer;
  deductionsCentavos: Buffer;
  netPayCentavos: Buffer;
  reimbursementsCentavos: Buffer;
  taxWithheldCentavos: Buffer;
  employeeContributionsCentavos: Buffer;
  employerContributionsCentavos: Buffer;
}

/** The totals' fields, in the order the run page shows them (each also a reveal field name). */
export const PAYROLL_RUN_TOTAL_PATHS = [
  'grossCentavos',
  'deductionsCentavos',
  'netPayCentavos',
  'reimbursementsCentavos',
  'taxWithheldCentavos',
  'employeeContributionsCentavos',
  'employerContributionsCentavos',
] as const satisfies readonly (keyof PayrollRunTotals)[];

/** How many lines carry each flag, set by each recompute (plain, no amount). */
export type PayrollRunFlagCounts = Record<PayrollLineFlagKind, number>;

export interface PayrollRunFiscalPosting {
  status: PayrollFiscalPostingStatus;
}

export interface PayrollRunDocument {
  _id: Types.ObjectId;
  number: string;
  kind: PayrollRunModelKind;
  cutOffKey: CutOffKey;
  /** 00:00 Manila on each day, stored in UTC (as on timesheets). */
  periodStart: Date;
  periodEnd: Date;
  payDate: Date;
  /** `YYYY-MM`, the pay date's month. */
  contributionMonth: string;
  status: PayrollRunModelStatus;
  computedAt: Date;
  /** The user who last computed it, or null for the job and the listener. */
  computedBy: Types.ObjectId | null;
  settingVersions: PayrollRunSettingVersion[];
  employeeCount: number;
  leftOut: PayrollRunLeftOut[];
  totals: PayrollRunTotals;
  /** Step 2.10: per flag kind, the lines carrying it (each 0 before the first 2.10 recompute). */
  flagCounts: PayrollRunFlagCounts;
  /** Step 2.10: the latest submit, or null. */
  submittedAt: Date | null;
  submittedBy: Types.ObjectId | null;
  /** Step 2.10: the latest approval request, or null. */
  approvalRequestId: Types.ObjectId | null;
  /** Step 2.10: the latest return, or null. */
  returnedAt: Date | null;
  returnedBy: Types.ObjectId | null;
  returnRemarks: string | null;
  /** Step 2.10: set once, by the approval (the Board member). */
  finalizedAt: Date | null;
  finalizedBy: Types.ObjectId | null;
  /** Step 2.10: `{ status: 'notPosted' }` once finalized, else null (step 5.8 posts it). */
  fiscalPosting: PayrollRunFiscalPosting | null;
  /** Step 2.10: true from finalizing until every payslip PDF is rendered. */
  payslipsPending: boolean;
  /** Raised on each recompute and status move, so two writes can't interleave. */
  version: number;
  createdAt: Date;
  updatedAt: Date;
  createdBy: Types.ObjectId | null;
  updatedBy: Types.ObjectId | null;
}

const settingVersionSchema = new Schema<PayrollRunSettingVersion>(
  {
    key: { type: String, required: true, trim: true, minlength: 1, maxlength: 100 },
    effectiveFrom: { type: String, default: null, match: BUSINESS_DATE_PATTERN },
  },
  { _id: false },
);

const leftOutSchema = new Schema<PayrollRunLeftOut>(
  {
    employeeId: { type: Schema.Types.ObjectId, required: true },
    reason: { type: String, enum: LEFT_OUT_REASONS, required: true },
  },
  { _id: false },
);

const totalsSchema = new Schema<PayrollRunTotals>(
  {
    grossCentavos: sensitiveField({ required: true }),
    deductionsCentavos: sensitiveField({ required: true }),
    netPayCentavos: sensitiveField({ required: true }),
    reimbursementsCentavos: sensitiveField({ required: true }),
    taxWithheldCentavos: sensitiveField({ required: true }),
    employeeContributionsCentavos: sensitiveField({ required: true }),
    employerContributionsCentavos: sensitiveField({ required: true }),
  },
  { _id: false },
);

const flagCountsSchema = new Schema<PayrollRunFlagCounts>(
  Object.fromEntries(
    PAYROLL_LINE_FLAG_KINDS.map((kind) => [
      kind,
      { type: Number, required: true, default: 0, validate: wholeNumber(0) },
    ]),
  ),
  { _id: false },
);

const fiscalPostingSchema = new Schema<PayrollRunFiscalPosting>(
  { status: { type: String, enum: PAYROLL_FISCAL_POSTING_STATUSES, required: true } },
  { _id: false },
);

const payrollRunSchema = new Schema<PayrollRunDocument>({
  number: {
    type: String,
    required: true,
    immutable: true,
    match: PAYROLL_RUN_NUMBER_PATTERN,
  },
  kind: { type: String, enum: RUN_KINDS, required: true, immutable: true },
  cutOffKey: { type: String, enum: CUT_OFF_KEYS, required: true, immutable: true },
  periodStart: { type: Date, required: true, immutable: true },
  periodEnd: { type: Date, required: true, immutable: true },
  payDate: { type: Date, required: true, immutable: true },
  contributionMonth: {
    type: String,
    required: true,
    immutable: true,
    match: CONTRIBUTION_MONTH_PATTERN,
  },
  status: { type: String, enum: RUN_STATUSES, required: true, default: 'draft' },
  computedAt: { type: Date, required: true },
  computedBy: { type: Schema.Types.ObjectId, default: null },
  settingVersions: { type: [settingVersionSchema], default: [] },
  employeeCount: { type: Number, required: true, validate: wholeNumber(0) },
  leftOut: { type: [leftOutSchema], default: [] },
  totals: { type: totalsSchema, required: true },
  flagCounts: { type: flagCountsSchema, default: () => ({}) },
  submittedAt: { type: Date, default: null },
  submittedBy: { type: Schema.Types.ObjectId, default: null },
  approvalRequestId: { type: Schema.Types.ObjectId, default: null },
  returnedAt: { type: Date, default: null },
  returnedBy: { type: Schema.Types.ObjectId, default: null },
  returnRemarks: {
    type: String,
    default: null,
    trim: true,
    minlength: 1,
    maxlength: PAYROLL_RUN_RETURN_REMARKS_MAX_LENGTH,
  },
  finalizedAt: { type: Date, default: null },
  finalizedBy: { type: Schema.Types.ObjectId, default: null },
  fiscalPosting: { type: fiscalPostingSchema, default: null },
  payslipsPending: { type: Boolean, required: true, default: false },
  version: { type: Number, required: true, default: 1, validate: wholeNumber(1) },
});

payrollRunSchema.index({ number: 1 }, { unique: true });
/** One run of a kind per cut-off. */
export const ONE_RUN_PER_CUT_OFF_INDEX = 'oneRunPerCutOff';
payrollRunSchema.index(
  { kind: 1, periodStart: 1 },
  { unique: true, name: ONE_RUN_PER_CUT_OFF_INDEX },
);
payrollRunSchema.index({ status: 1, periodStart: 1 });

const RUN_GUARD_MESSAGE =
  'A payroll run is never deleted. It changes only through the payroll run service: a draft or returned run by being recomputed, and any run by its submit, return, finalize and payslip steps.';

/** The base fields every update may set (the timestamps plugin's). */
const BASE_SET_KEYS = ['updatedAt', 'updatedBy'];
/** The fields a recompute sets: step 2.9's and, from step 2.10, `flagCounts`. */
const RECOMPUTE_SET_KEYS = new Set<string>([
  'computedAt',
  'computedBy',
  'settingVersions',
  'employeeCount',
  'leftOut',
  'totals',
  'flagCounts',
  ...BASE_SET_KEYS,
]);
const SUBMIT_SET_KEYS = new Set<string>([
  'status',
  'submittedAt',
  'submittedBy',
  'approvalRequestId',
  ...BASE_SET_KEYS,
]);
const RETURN_SET_KEYS = new Set<string>([
  'status',
  'returnedAt',
  'returnedBy',
  'returnRemarks',
  ...BASE_SET_KEYS,
]);
const FINALIZE_SET_KEYS = new Set<string>([
  'status',
  'finalizedAt',
  'finalizedBy',
  'fiscalPosting',
  'payslipsPending',
  ...BASE_SET_KEYS,
]);
const CLEAR_PAYSLIPS_PENDING_SET_KEYS = new Set<string>(['payslipsPending', ...BASE_SET_KEYS]);
const RUN_UPDATE_OPERATORS = new Set(['$set', '$inc']);
const VERSION_INC_KEYS = new Set(['version', '__v']);

/**
 * The statuses a query's filter limits it to: `status: 'x'` or `status: { $in: [...] }` (strings
 * only), or null when the filter doesn't pin the status.
 */
function filteredStatuses(query: Query<unknown, unknown>): Set<string> | null {
  const status: unknown = query.getFilter().status;
  if (typeof status === 'string') return new Set([status]);
  if (
    typeof status === 'object' &&
    status !== null &&
    hasOnlyKeys(status, new Set(['$in'])) &&
    Array.isArray((status as { $in?: unknown }).$in)
  ) {
    const values = (status as { $in: unknown[] }).$in;
    if (values.length > 0 && values.every((value) => typeof value === 'string')) {
      return new Set(values as string[]);
    }
  }
  return null;
}

const isSubsetOf = (values: Set<string>, allowed: readonly string[]) =>
  [...values].every((value) => allowed.includes(value));
const present = (value: unknown) => value !== undefined && value !== null;

/** True when `$inc` raises `version` by exactly 1 (and touches nothing but `version`, `__v`). */
function raisesVersion(inc: Record<string, unknown> | undefined): boolean {
  return inc !== undefined && hasOnlyKeys(inc, VERSION_INC_KEYS) && inc.version === 1;
}

/** True for one of decision 371's run updates; see the header comment. */
function isAllowedRunUpdate(update: UpdateQuery<unknown>, query: Query<unknown, unknown>): boolean {
  if (Array.isArray(update) || Object.keys(update).length === 0) return false;
  if (!hasOnlyKeys(update, RUN_UPDATE_OPERATORS)) return false;
  const options = query.getOptions();
  if (options.upsert === true || options.overwrite === true) return false;
  const set = (update.$set ?? {}) as Record<string, unknown>;
  const inc = update.$inc as Record<string, unknown> | undefined;
  if (typeof set !== 'object' || set === null) return false;
  const statuses = filteredStatuses(query);
  if (!statuses) return false;
  const editable = isSubsetOf(statuses, PAYROLL_RUN_EDITABLE_STATUSES);
  const only = (status: PayrollRunModelStatus) => statuses.size === 1 && statuses.has(status);

  switch (set.status) {
    case undefined:
      // A recompute of a draft or returned run.
      if (editable) return hasOnlyKeys(set, RECOMPUTE_SET_KEYS) && raisesVersion(inc);
      // Clearing `payslipsPending` once every payslip PDF is rendered: nothing else, no `$inc`.
      if (only('finalized')) {
        return (
          inc === undefined &&
          hasOnlyKeys(set, CLEAR_PAYSLIPS_PENDING_SET_KEYS) &&
          set.payslipsPending === false
        );
      }
      return false;
    case 'pendingApproval':
      return (
        editable &&
        hasOnlyKeys(set, SUBMIT_SET_KEYS) &&
        present(set.submittedAt) &&
        present(set.submittedBy) &&
        present(set.approvalRequestId) &&
        raisesVersion(inc)
      );
    case 'returned': {
      const remarks = set.returnRemarks;
      return (
        only('pendingApproval') &&
        hasOnlyKeys(set, RETURN_SET_KEYS) &&
        present(set.returnedAt) &&
        present(set.returnedBy) &&
        typeof remarks === 'string' &&
        remarks.trim().length >= 1 &&
        remarks.trim().length <= PAYROLL_RUN_RETURN_REMARKS_MAX_LENGTH &&
        raisesVersion(inc)
      );
    }
    case 'finalized': {
      const posting = set.fiscalPosting;
      return (
        only('pendingApproval') &&
        hasOnlyKeys(set, FINALIZE_SET_KEYS) &&
        present(set.finalizedAt) &&
        present(set.finalizedBy) &&
        typeof posting === 'object' &&
        posting !== null &&
        hasOnlyKeys(posting, new Set(['status'])) &&
        (posting as { status?: unknown }).status === 'notPosted' &&
        set.payslipsPending === true &&
        raisesVersion(inc)
      );
    }
    default:
      return false;
  }
}

/** Refuses every write that isn't an insert, or one of decision 371's run updates. */
function guardRunWrites(schema: Schema): void {
  schema.pre(
    [
      'replaceOne',
      'findOneAndReplace',
      'deleteOne',
      'deleteMany',
      'findOneAndDelete',
      'updateMany',
    ],
    { document: false, query: true },
    function () {
      throw new Error(RUN_GUARD_MESSAGE);
    },
  );
  schema.pre(
    ['updateOne', 'findOneAndUpdate'],
    { document: false, query: true },
    function (this: Query<unknown, unknown>) {
      const update = this.getUpdate();
      if (update === null || !isAllowedRunUpdate(update, this)) {
        throw new Error(RUN_GUARD_MESSAGE);
      }
    },
  );
  schema.pre(['deleteOne', 'updateOne'], { document: true, query: false }, function () {
    throw new Error(RUN_GUARD_MESSAGE);
  });
  schema.pre('bulkWrite', function (ops) {
    if (ops.some((op) => !('insertOne' in op))) throw new Error(RUN_GUARD_MESSAGE);
  });
  schema.pre('save', function () {
    if (!this.isNew) throw new Error(RUN_GUARD_MESSAGE);
  });
  schema.pre('aggregate', function () {
    if (this.pipeline().some((stage) => '$merge' in stage || '$out' in stage)) {
      throw new Error(RUN_GUARD_MESSAGE);
    }
  });
}

guardRunWrites(payrollRunSchema);

// Never deleted, so no soft delete either.
payrollRunSchema.plugin(baseSchemaPlugin, { softDelete: false });

export const PayrollRunModel = defineModel('PayrollRun', payrollRunSchema, 'payrollRuns');

/**
 * Throws `error` unless every run in `runIds` exists and has one of `statuses`, read in `session`
 * (so a run created or moved in the same transaction is seen as it is there). Also used by the
 * manual entry and acknowledgement models (../payroll-review/model.ts).
 */
export async function assertPayrollRunsIn(
  runIds: unknown[],
  statuses: readonly PayrollRunModelStatus[],
  session: ClientSession | null | undefined,
  error: () => Error,
): Promise<void> {
  const ids = [...new Set(runIds.map((id) => String(id)))];
  if (ids.some((id) => !Types.ObjectId.isValid(id) || !/^[0-9a-f]{24}$/i.test(id))) throw error();
  if (ids.length === 0) return;
  const found = await PayrollRunModel.countDocuments({
    _id: { $in: ids.map((id) => new Types.ObjectId(id)) },
    status: { $in: [...statuses] },
  }).session(session ?? null);
  if (found !== ids.length) throw error();
}

// ---------------------------------------------------------------------------------------------
// payrollRunEmployees

/** One review flag on a line (plain): its kind and, for `onboardingIncomplete`, what's missing. */
export interface PayrollLineFlag {
  kind: PayrollLineFlagKind;
  items: string[];
}

/** The payroll bank account frozen on a payslip; the account number is encrypted. */
export interface PayslipBankSnapshot {
  bank: PayrollBank;
  accountName: string | null;
  /** The encrypted account number (category `bank`, re-encrypted from the employee record). */
  accountNumber: Buffer;
}

/** The payslip snapshot, frozen at finalizing (decision 363). */
export interface PayslipSnapshot {
  employeeName: string;
  employeeNumber: string;
  departmentName: string | null;
  positionTitle: string | null;
  /** The payroll bank account, or null (paid by other means). */
  bank: PayslipBankSnapshot | null;
  /**
   * The encrypted year-to-date figures (category `payslip`): one JSON string with gross, tax
   * withheld and the SSS, PhilHealth and Pag-IBIG employee shares.
   */
  ytd: Buffer;
  /** The rendered PDF's file, or null until rendered. */
  fileId: Types.ObjectId | null;
  generatedAt: Date | null;
}

export interface PayrollRunEmployeeDocument {
  _id: Types.ObjectId;
  runId: Types.ObjectId;
  employeeId: Types.ObjectId;
  /** The run's period start, for the reconciliation's lookups. */
  periodStart: Date;
  timesheetId: Types.ObjectId | null;
  /** The timesheet's status read at compute, or null with no timesheet. */
  timesheetStatus: TimesheetStatus | null;
  timesheetApproved: boolean;
  /** The period starts this line pays attendance items for (its own and the settled ones). */
  settledPeriods: Date[];
  /** True when net pay is below zero (step 2.10 resolves it). */
  negativeNet: boolean;
  /** Each the encrypted whole number of centavos (category `payslip`). */
  grossCentavos: Buffer;
  deductionsCentavos: Buffer;
  netPayCentavos: Buffer;
  reimbursementsCentavos: Buffer;
  /** The encrypted breakdown: one JSON string (category `payslip`). */
  breakdown: Buffer;
  /** The breakdown's JSON shape: 1 in step 2.9; 2 from step 2.10 (manual and overridden lines). */
  breakdownVersion: number;
  /** Step 2.10: the review flags, plain (empty on step 2.9 lines). */
  flags: PayrollLineFlag[];
  /** Step 2.10: the live manual entries applied to the line. */
  manualEntryCount: number;
  /** Step 2.10: null until the run is finalized. */
  payslip: PayslipSnapshot | null;
  createdAt: Date;
  updatedAt: Date;
  createdBy: Types.ObjectId | null;
  updatedBy: Types.ObjectId | null;
}

/** The line's top-level sensitive paths (each also a reveal field name source). */
export const PAYROLL_RUN_EMPLOYEE_SENSITIVE_PATHS = [
  'grossCentavos',
  'deductionsCentavos',
  'netPayCentavos',
  'reimbursementsCentavos',
  'breakdown',
] as const satisfies readonly (keyof PayrollRunEmployeeDocument)[];

/** The payslip snapshot's sensitive paths, for `.select()`. */
export const PAYSLIP_SNAPSHOT_SENSITIVE_PATHS = [
  'payslip.bank.accountNumber',
  'payslip.ytd',
] as const;
/** Selects the payslip snapshot's encrypted fields: `.select(PAYSLIP_SNAPSHOT_SELECT)`. */
export const PAYSLIP_SNAPSHOT_SELECT = PAYSLIP_SNAPSHOT_SENSITIVE_PATHS.map(
  (path) => `+${path}`,
).join(' ');

const lineFlagSchema = new Schema<PayrollLineFlag>(
  {
    kind: { type: String, enum: PAYROLL_LINE_FLAG_KINDS, required: true },
    items: {
      type: [{ type: String, trim: true, minlength: 1, maxlength: 200 }],
      default: [],
    },
  },
  { _id: false },
);

const payslipBankSchema = new Schema<PayslipBankSnapshot>(
  {
    bank: { type: String, enum: PAYROLL_BANKS, required: true },
    accountName: { type: String, default: null, trim: true, maxlength: 200 },
    accountNumber: sensitiveField({ required: true }),
  },
  { _id: false },
);

const payslipSchema = new Schema<PayslipSnapshot>(
  {
    employeeName: { type: String, required: true, trim: true, minlength: 1, maxlength: 200 },
    employeeNumber: { type: String, required: true, trim: true, minlength: 1, maxlength: 50 },
    departmentName: { type: String, default: null, trim: true, maxlength: 200 },
    positionTitle: { type: String, default: null, trim: true, maxlength: 200 },
    bank: { type: payslipBankSchema, default: null },
    ytd: sensitiveField({ required: true }),
    fileId: { type: Schema.Types.ObjectId, default: null },
    generatedAt: { type: Date, default: null },
  },
  { _id: false },
);

const payrollRunEmployeeSchema = new Schema<PayrollRunEmployeeDocument>({
  runId: { type: Schema.Types.ObjectId, required: true, immutable: true },
  employeeId: { type: Schema.Types.ObjectId, required: true, immutable: true },
  periodStart: { type: Date, required: true, immutable: true },
  timesheetId: { type: Schema.Types.ObjectId, default: null, immutable: true },
  timesheetStatus: { type: String, enum: TIMESHEET_STATUSES, default: null },
  timesheetApproved: { type: Boolean, required: true },
  settledPeriods: { type: [Date], default: [] },
  negativeNet: { type: Boolean, required: true },
  grossCentavos: sensitiveField({ required: true }),
  deductionsCentavos: sensitiveField({ required: true }),
  netPayCentavos: sensitiveField({ required: true }),
  reimbursementsCentavos: sensitiveField({ required: true }),
  breakdown: sensitiveField({ required: true }),
  breakdownVersion: { type: Number, required: true, validate: wholeNumber(1) },
  flags: { type: [lineFlagSchema], default: [] },
  manualEntryCount: { type: Number, required: true, default: 0, validate: wholeNumber(0) },
  payslip: { type: payslipSchema, default: null },
});

payrollRunEmployeeSchema.index({ runId: 1, employeeId: 1 }, { unique: true });
payrollRunEmployeeSchema.index({ employeeId: 1, periodStart: 1 });
payrollRunEmployeeSchema.index({ employeeId: 1, settledPeriods: 1 });

const LINE_GUARD_MESSAGE =
  'Payroll run lines are never edited: a draft or returned run’s lines are replaced as a set by recomputing it, and after that only the payslip is recorded, once at finalizing and its PDF once after.';

const lineGuardError = () => new Error(LINE_GUARD_MESSAGE);

/** Throws unless every run in `runIds` exists and is `draft` or `returned`, read in `session`. */
async function assertEditableRuns(
  runIds: unknown[],
  session: ClientSession | null | undefined,
): Promise<void> {
  await assertPayrollRunsIn(runIds, PAYROLL_RUN_EDITABLE_STATUSES, session, lineGuardError);
}

function runIdOf(doc: unknown): unknown {
  return typeof doc === 'object' && doc !== null ? (doc as { runId?: unknown }).runId : undefined;
}

const SNAPSHOT_SET_KEYS = new Set<string>(['payslip', ...BASE_SET_KEYS]);
const PAYSLIP_FILE_SET_KEYS = new Set<string>([
  'payslip.fileId',
  'payslip.generatedAt',
  ...BASE_SET_KEYS,
]);

type LineUpdateKind = 'snapshot' | 'payslipFile';

/**
 * Which allowed line update this is, or null: the payslip snapshot (filtered on an ObjectId
 * `runId` and `payslip: null`, `$set` of a whole `payslip` with no file yet) or the payslip file
 * (filtered on an ObjectId `runId` and `payslip.fileId: null`, `$set` of `payslip.fileId` and
 * `payslip.generatedAt`). Only `$set`; the run's status is checked by the caller.
 */
function lineUpdateKind(filter: Record<string, unknown>, update: unknown): LineUpdateKind | null {
  if (typeof update !== 'object' || update === null || Array.isArray(update)) return null;
  if (!hasOnlyKeys(update, new Set(['$set']))) return null;
  const set = (update as { $set?: unknown }).$set;
  if (typeof set !== 'object' || set === null) return null;
  if (!(filter.runId instanceof Types.ObjectId)) return null;
  const fields = set as Record<string, unknown>;
  if ('payslip' in filter && filter.payslip === null && hasOnlyKeys(fields, SNAPSHOT_SET_KEYS)) {
    const payslip = fields.payslip as Record<string, unknown> | null | undefined;
    if (typeof payslip !== 'object' || payslip === null) return null;
    if (present(payslip.fileId) || present(payslip.generatedAt)) return null;
    return 'snapshot';
  }
  if (
    'payslip.fileId' in filter &&
    filter['payslip.fileId'] === null &&
    hasOnlyKeys(fields, PAYSLIP_FILE_SET_KEYS) &&
    present(fields['payslip.fileId']) &&
    present(fields['payslip.generatedAt'])
  ) {
    return 'payslipFile';
  }
  return null;
}

/** The run status each allowed line update needs. */
const RUN_STATUS_FOR: Record<LineUpdateKind, PayrollRunModelStatus> = {
  snapshot: 'pendingApproval',
  payslipFile: 'finalized',
};

/**
 * The lines' guard: inserts only for editable runs, `deleteMany({ runId })` only for an editable
 * run's lines, the payslip snapshot once while the run is pending, and the payslip file once on a
 * finalized run; every other update, replacement and delete is refused.
 */
function guardLineWrites(schema: Schema): void {
  schema.pre(
    ['updateMany', 'replaceOne', 'findOneAndReplace', 'deleteOne', 'findOneAndDelete'],
    { document: false, query: true },
    function () {
      throw lineGuardError();
    },
  );
  schema.pre(
    ['updateOne', 'findOneAndUpdate'],
    { document: false, query: true },
    async function (this: Query<unknown, unknown>) {
      const options = this.getOptions();
      if (options.upsert === true || options.overwrite === true) throw lineGuardError();
      const filter = this.getFilter();
      const kind = lineUpdateKind(filter, this.getUpdate());
      if (!kind) throw lineGuardError();
      await assertPayrollRunsIn(
        [filter.runId],
        [RUN_STATUS_FOR[kind]],
        options.session,
        lineGuardError,
      );
      // `payslip.fileId: null` also matches a line with no snapshot: never let the file step
      // create a partial payslip.
      if (kind === 'payslipFile') this.setQuery({ ...filter, payslip: { $type: 'object' } });
    },
  );
  schema.pre(
    'deleteMany',
    { document: false, query: true },
    async function (this: Query<unknown, unknown>) {
      const filter = this.getFilter();
      if (!hasOnlyKeys(filter, new Set(['runId'])) || filter.runId === undefined) {
        throw lineGuardError();
      }
      if (!(filter.runId instanceof Types.ObjectId)) throw lineGuardError();
      await assertEditableRuns([filter.runId], this.getOptions().session);
    },
  );
  schema.pre(['deleteOne', 'updateOne'], { document: true, query: false }, function () {
    throw lineGuardError();
  });
  schema.pre('save', async function () {
    if (!this.isNew) throw lineGuardError();
    await assertEditableRuns([this.get('runId')], this.$session());
  });
  // `insertMany`'s middleware isn't given the write's session, so a run created in the same
  // transaction couldn't be checked: insert lines with `bulkWrite` (`insertOne` operations, with
  // the session) or `create(lines, { session, ordered: true })` instead.
  schema.pre('insertMany', function () {
    throw new Error(
      'Insert payroll run lines with bulkWrite insertOne operations or create(), with the session, so the run is checked to be a draft or returned.',
    );
  });
  // Either all inserts (for editable runs) or all payslip snapshots (for pending runs), so the
  // finalize hook can set every line's snapshot in one round trip.
  schema.pre('bulkWrite', async function (ops, options) {
    if (ops.length === 0) return;
    if (ops.every((op) => 'insertOne' in op)) {
      await assertEditableRuns(
        ops.map((op) => ('insertOne' in op ? runIdOf(op.insertOne.document) : undefined)),
        options?.session,
      );
      return;
    }
    const runIds: unknown[] = [];
    for (const op of ops) {
      if (!('updateOne' in op)) throw lineGuardError();
      const { filter, update, upsert } = op.updateOne as {
        filter: Record<string, unknown>;
        update: unknown;
        upsert?: boolean;
      };
      if (upsert === true || lineUpdateKind(filter, update) !== 'snapshot') throw lineGuardError();
      runIds.push(filter.runId);
    }
    await assertPayrollRunsIn(runIds, ['pendingApproval'], options?.session, lineGuardError);
  });
  schema.pre('aggregate', function () {
    if (this.pipeline().some((stage) => '$merge' in stage || '$out' in stage)) {
      throw lineGuardError();
    }
  });
}

guardLineWrites(payrollRunEmployeeSchema);

// Never soft-deleted: an editable run's lines are replaced, and a finalized run's lines are kept.
payrollRunEmployeeSchema.plugin(baseSchemaPlugin, { softDelete: false });

export const PayrollRunEmployeeModel = defineModel(
  'PayrollRunEmployee',
  payrollRunEmployeeSchema,
  'payrollRunEmployees',
);
