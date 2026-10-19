import { type ClientSession, type Query, Schema, Types } from 'mongoose';
import { baseSchemaPlugin, defineModel } from '@pulse/db';
import { hasOnlyKeys, sensitiveField } from '@pulse/core/server';
import { CUT_OFF_KEYS, type CutOffKey } from '../../payroll/schemas';
import { TIMESHEET_STATUSES, type TimesheetStatus } from '../../timesheets/schemas';

// Spec: docs/DATA_MODEL.md#collection-ownership (`payrollRuns`, `payrollRunEmployees`, build step
// 2.9), docs/modules/talent.md#payroll-run-computation-build-step-29 ("Payroll runs", "The
// employee line", "Recomputing a draft") and SECURITY.md#sensitive-data ("Payroll runs";
// decisions 327, 340, 341 and 343 in docs/BUILD_PLAN.md).
//
// - `payrollRuns`: one regular run per cut-off (unique `{ kind, periodStart }`), numbered
//   `PAY-YYYY-NNNN` with the pay date's year when it is created. Statuses are declared for step
//   2.10; step 2.9 writes only `draft`. Never deleted. The run's totals are a subdocument of
//   `sensitiveField()`s (category `payslip`), encrypted with `encryptSensitive`; the counts, the
//   dates and the people left out are plain.
// - The guard lets a run change only while it is a draft: an update must filter on
//   `status: 'draft'`, use only `$set` and `$inc`, and touch only the recompute's fields (the
//   totals, settings, counts, `computedAt`, `computedBy`, `leftOut`, `version`). The fixed fields
//   (number, kind, cut-off, dates, contribution month) are immutable. Step 2.10 extends it for
//   the review and approval.
// - `payrollRunEmployees`: one line per employee in a run (unique `{ runId, employeeId }`). The
//   line's breakdown (one JSON string, `breakdownVersion` 1) and its gross, deductions, net pay
//   and reimbursements are `sensitiveField()`s (category `payslip`). A draft's lines are replaced
//   as a set on each recompute: the guard lets through only inserts of lines for a draft run
//   (`bulkWrite` `insertOne` operations or `create()`; `insertMany` is refused, since its
//   middleware can't see the session), and a `deleteMany({ runId })` of a draft run's lines, each
//   checked against the run in the write's session. Every other write is refused, so once the run
//   leaves `draft` its lines never change.
// - Both collections get the `$jsonSchema` validator for their sensitive paths when their indexes
//   are built (ADR 0012). Written only by Talent's payroll run service (./service.ts, chunk C).
//
// The kind and status lists match `PAYROLL_RUN_KINDS` and `PAYROLL_RUN_STATUSES` of the pure pay
// engine (../../payroll-run/), built alongside; the service may import those instead.

/** The audit record type of a run, and the reveal owner type of a line. */
export const PAYROLL_RUN_RECORD_TYPE = 'talent.payrollRun';
export const PAYROLL_RUN_EMPLOYEE_RECORD_TYPE = 'talent.payrollRunEmployee';

/** `kind`: `regular` (step 2.9); `thirteenthMonth` from step 2.12. */
const RUN_KINDS = ['regular', 'thirteenthMonth'] as const;
export type PayrollRunModelKind = (typeof RUN_KINDS)[number];
/** `status`: step 2.9 writes only `draft`; step 2.10 the rest. */
const RUN_STATUSES = ['draft', 'pendingApproval', 'returned', 'finalized'] as const;
export type PayrollRunModelStatus = (typeof RUN_STATUSES)[number];
/** Why an employee is left out of a run. */
const LEFT_OUT_REASONS = ['noSalary'] as const;
export type PayrollRunLeftOutReason = (typeof LEFT_OUT_REASONS)[number];

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
  /** Raised on each recompute, so two recomputes can't interleave. */
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
  'A payroll run is never deleted, and only a draft changes, by being recomputed through the payroll run service.';
/** The fields a recompute sets (with the base fields' `updatedAt` and `updatedBy`). */
const RECOMPUTE_SET_KEYS = new Set<string>([
  'computedAt',
  'computedBy',
  'settingVersions',
  'employeeCount',
  'leftOut',
  'totals',
  'updatedAt',
  'updatedBy',
]);
const RUN_UPDATE_OPERATORS = new Set(['$set', '$inc']);

/** True when the query matches drafts only: its filter has `status: 'draft'`. */
function filtersOnDraft(query: Query<unknown, unknown>): boolean {
  return query.getFilter().status === 'draft';
}

/** Refuses every write that isn't an insert, or an allowed update of a draft run. */
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
      const options = this.getOptions();
      const allowed =
        update !== null &&
        !Array.isArray(update) &&
        Object.keys(update).length > 0 &&
        hasOnlyKeys(update, RUN_UPDATE_OPERATORS) &&
        hasOnlyKeys(update.$set ?? {}, RECOMPUTE_SET_KEYS) &&
        hasOnlyKeys(update.$inc ?? {}, new Set(['version', '__v'])) &&
        options.upsert !== true &&
        options.overwrite !== true &&
        filtersOnDraft(this);
      if (!allowed) throw new Error(RUN_GUARD_MESSAGE);
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

// ---------------------------------------------------------------------------------------------
// payrollRunEmployees

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
  /** The breakdown's JSON shape: 1 in step 2.9. */
  breakdownVersion: number;
  createdAt: Date;
  updatedAt: Date;
  createdBy: Types.ObjectId | null;
  updatedBy: Types.ObjectId | null;
}

/** The line's sensitive paths (each also a reveal field name source). */
export const PAYROLL_RUN_EMPLOYEE_SENSITIVE_PATHS = [
  'grossCentavos',
  'deductionsCentavos',
  'netPayCentavos',
  'reimbursementsCentavos',
  'breakdown',
] as const satisfies readonly (keyof PayrollRunEmployeeDocument)[];

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
});

payrollRunEmployeeSchema.index({ runId: 1, employeeId: 1 }, { unique: true });
payrollRunEmployeeSchema.index({ employeeId: 1, periodStart: 1 });
payrollRunEmployeeSchema.index({ employeeId: 1, settledPeriods: 1 });

const LINE_GUARD_MESSAGE =
  'Payroll run lines are never edited: a draft run’s lines are replaced as a set by recomputing it, and a run that has left draft never changes.';

/** Throws unless every run in `runIds` exists and is a draft, read in `session`. */
async function assertDraftRuns(
  runIds: unknown[],
  session: ClientSession | null | undefined,
): Promise<void> {
  const ids = [...new Set(runIds.map((id) => String(id)))];
  if (ids.some((id) => !Types.ObjectId.isValid(id))) throw new Error(LINE_GUARD_MESSAGE);
  if (ids.length === 0) return;
  const drafts = await PayrollRunModel.countDocuments({
    _id: { $in: ids.map((id) => new Types.ObjectId(id)) },
    status: 'draft',
  }).session(session ?? null);
  if (drafts !== ids.length) throw new Error(LINE_GUARD_MESSAGE);
}

function runIdOf(doc: unknown): unknown {
  return typeof doc === 'object' && doc !== null ? (doc as { runId?: unknown }).runId : undefined;
}

/**
 * The lines' guard: inserts only for draft runs, and `deleteMany({ runId })` only for a draft
 * run's lines; every update, replacement and other delete is refused.
 */
function guardLineWrites(schema: Schema): void {
  schema.pre(
    [
      'updateOne',
      'updateMany',
      'findOneAndUpdate',
      'replaceOne',
      'findOneAndReplace',
      'deleteOne',
      'findOneAndDelete',
    ],
    { document: false, query: true },
    function () {
      throw new Error(LINE_GUARD_MESSAGE);
    },
  );
  schema.pre(
    'deleteMany',
    { document: false, query: true },
    async function (this: Query<unknown, unknown>) {
      const filter = this.getFilter();
      if (!hasOnlyKeys(filter, new Set(['runId'])) || filter.runId === undefined) {
        throw new Error(LINE_GUARD_MESSAGE);
      }
      if (!(filter.runId instanceof Types.ObjectId)) throw new Error(LINE_GUARD_MESSAGE);
      await assertDraftRuns([filter.runId], this.getOptions().session);
    },
  );
  schema.pre(['deleteOne', 'updateOne'], { document: true, query: false }, function () {
    throw new Error(LINE_GUARD_MESSAGE);
  });
  schema.pre('save', async function () {
    if (!this.isNew) throw new Error(LINE_GUARD_MESSAGE);
    await assertDraftRuns([this.get('runId')], this.$session());
  });
  // `insertMany`'s middleware isn't given the write's session, so a run created in the same
  // transaction couldn't be checked: insert lines with `bulkWrite` (`insertOne` operations, with
  // the session) or `create(lines, { session, ordered: true })` instead.
  schema.pre('insertMany', function () {
    throw new Error(
      'Insert payroll run lines with bulkWrite insertOne operations or create(), with the session, so the run is checked to be a draft.',
    );
  });
  schema.pre('bulkWrite', async function (ops, options) {
    if (ops.some((op) => !('insertOne' in op))) throw new Error(LINE_GUARD_MESSAGE);
    await assertDraftRuns(
      ops.map((op) => ('insertOne' in op ? runIdOf(op.insertOne.document) : undefined)),
      options?.session,
    );
  });
  schema.pre('aggregate', function () {
    if (this.pipeline().some((stage) => '$merge' in stage || '$out' in stage)) {
      throw new Error(LINE_GUARD_MESSAGE);
    }
  });
}

guardLineWrites(payrollRunEmployeeSchema);

// Never soft-deleted: a draft's lines are replaced, and a finalized run's lines are kept.
payrollRunEmployeeSchema.plugin(baseSchemaPlugin, { softDelete: false });

export const PayrollRunEmployeeModel = defineModel(
  'PayrollRunEmployee',
  payrollRunEmployeeSchema,
  'payrollRunEmployees',
);
