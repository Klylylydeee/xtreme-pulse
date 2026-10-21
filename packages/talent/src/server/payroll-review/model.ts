import { type ClientSession, Schema, type Types } from 'mongoose';
import { baseSchemaPlugin, defineModel } from '@pulse/db';
import { guardWrites, sensitiveField } from '@pulse/core/server';
import {
  assertPayrollRunsIn,
  PAYROLL_RUN_EDITABLE_STATUSES,
  type PayrollLineFlagKind,
} from '../payroll-runs/model';

// Spec: docs/DATA_MODEL.md#collection-ownership (`payrollManualEntries`,
// `payrollFlagAcknowledgements`, build step 2.10) and
// docs/modules/talent.md#payroll-review-approval-and-payslips-build-step-210 ("Review flags",
// "Manual entries"); decisions 353, 355, 356, 358, 359 and 371–372 in docs/BUILD_PLAN.md.
//
// - `payrollManualEntries`: HR's earnings, deductions and overrides on a run's line. Insert-only
//   (`guardWrites`): an edit or removal is a new entry that supersedes the latest of its chain
//   (`supersedesId`, one entry per superseded entry through a partial unique index); a removal is
//   marked `removed`. The amount is a `sensitiveField()` (category `payslip`), encrypted with
//   `encryptSensitive` and left out of queries unless selected; the label and reason are plain.
//   The amount's own rule (a whole number of centavos, 1 or more, or 0 or more for an override) is
//   checked by the service before it encrypts; the model checks the switches each kind needs.
// - `payrollFlagAcknowledgements`: one per run, employee and flag (unique), with a reason.
//   Insert-only.
// - Both are inserted only while the run is `draft` or `returned`, checked against the run in the
//   write's session (`create()` / `save()` with the session, or `bulkWrite` `insertOne`
//   operations); `insertMany` is refused, since its middleware isn't given the session.
// - `payrollManualEntries` gets the `$jsonSchema` validator for `amountCentavos` when its indexes
//   are built (ADR 0012). Both are written only by Talent's payroll review service.

/** The audit record type of a manual entry. */
export const PAYROLL_MANUAL_ENTRY_RECORD_TYPE = 'talent.payrollManualEntry';

/** A manual entry's kind (decision 355). */
export const PAYROLL_MANUAL_ENTRY_KINDS = ['earning', 'deduction', 'override'] as const;
export type PayrollManualEntryKind = (typeof PAYROLL_MANUAL_ENTRY_KINDS)[number];

export const PAYROLL_MANUAL_ENTRY_LABEL_MAX_LENGTH = 80;
export const PAYROLL_MANUAL_ENTRY_REASON_MAX_LENGTH = 500;
/** An override's computed line key: the engine's overridable line keys (../../payroll-run/). */
const TARGET_LINE_KEY_MAX_LENGTH = 100;

/** The flags HR may acknowledge (decision 353): never `netPayBelowZero` or `manualEntryStale`. */
export const ACKNOWLEDGEABLE_PAYROLL_FLAGS = [
  'onboardingIncomplete',
  'timesheetNotApproved',
  'belowMinimumWage',
] as const satisfies readonly PayrollLineFlagKind[];
export type AcknowledgeablePayrollFlag = (typeof ACKNOWLEDGEABLE_PAYROLL_FLAGS)[number];

export const PAYROLL_FLAG_ACKNOWLEDGEMENT_REASON_MAX_LENGTH = 300;

/** Throws `error` unless every run in `runIds` is `draft` or `returned`, read in `session`. */
async function assertEditable(
  runIds: unknown[],
  session: ClientSession | null | undefined,
  message: string,
): Promise<void> {
  await assertPayrollRunsIn(
    runIds,
    PAYROLL_RUN_EDITABLE_STATUSES,
    session,
    () => new Error(message),
  );
}

function runIdOf(doc: unknown): unknown {
  return typeof doc === 'object' && doc !== null ? (doc as { runId?: unknown }).runId : undefined;
}

/**
 * Insert-only, and inserted only for a `draft` or `returned` run, checked in the write's session.
 * `guardWrites` refuses every update, replacement and delete, and every `bulkWrite` operation but
 * `insertOne`; this adds the run check and refuses `insertMany`.
 */
function guardInsertsForEditableRuns(schema: Schema, message: string, notEditable: string): void {
  guardWrites(schema, { message });
  schema.pre('save', async function () {
    // guardWrites has already refused a save of a loaded document.
    await assertEditable([this.get('runId')], this.$session(), notEditable);
  });
  schema.pre('insertMany', function () {
    throw new Error(
      `${notEditable} Insert with create() or bulkWrite insertOne operations, with the session, so the run is checked.`,
    );
  });
  schema.pre('bulkWrite', async function (ops, options) {
    if (ops.some((op) => !('insertOne' in op))) throw new Error(message);
    await assertEditable(
      ops.map((op) => ('insertOne' in op ? runIdOf(op.insertOne.document) : undefined)),
      options?.session,
      notEditable,
    );
  });
}

// ---------------------------------------------------------------------------------------------
// payrollManualEntries

export interface PayrollManualEntryDocument {
  _id: Types.ObjectId;
  runId: Types.ObjectId;
  employeeId: Types.ObjectId;
  kind: PayrollManualEntryKind;
  /** An override's computed line, else null. */
  targetLineKey: string | null;
  /** Printed on the payslip ("Adjustment: <label>"): 1 to 80 characters, plain. */
  label: string;
  /**
   * The encrypted whole number of centavos (category `payslip`): 1 or more, or 0 or more for an
   * override. Absent only on a removal that doesn't carry it.
   */
  amountCentavos?: Buffer;
  /** Earning: taxable or not; null otherwise. */
  taxable: boolean | null;
  /** Deduction: lowers taxable pay (a correction) or not (after tax); null otherwise. */
  reducesTaxablePay: boolean | null;
  /** Deduction: authorized in writing or required by law; true when it is after tax. */
  authorizedInWriting: boolean | null;
  /** Earning or deduction: counts in basic salary earned; null for an override. */
  countsAsBasicSalary: boolean | null;
  /** 1 to 500 characters, plain (it goes into the audit entry's reason). */
  reason: string;
  /** The entry this one changes or removes, or null for the first of its chain. */
  supersedesId: Types.ObjectId | null;
  /** True on a removal. */
  removed: boolean;
  createdAt: Date;
  updatedAt: Date;
  createdBy: Types.ObjectId | null;
  updatedBy: Types.ObjectId | null;
}

/** Selects the entry's encrypted amount: `.select(PAYROLL_MANUAL_ENTRY_AMOUNT_SELECT)`. */
export const PAYROLL_MANUAL_ENTRY_AMOUNT_SELECT = '+amountCentavos';

const switchField = { type: Boolean, default: null, immutable: true };

const payrollManualEntrySchema = new Schema<PayrollManualEntryDocument>({
  runId: { type: Schema.Types.ObjectId, required: true, immutable: true },
  employeeId: { type: Schema.Types.ObjectId, required: true, immutable: true },
  kind: { type: String, enum: PAYROLL_MANUAL_ENTRY_KINDS, required: true, immutable: true },
  targetLineKey: {
    type: String,
    default: null,
    trim: true,
    minlength: 1,
    maxlength: TARGET_LINE_KEY_MAX_LENGTH,
    immutable: true,
  },
  label: {
    type: String,
    required: true,
    trim: true,
    minlength: 1,
    maxlength: PAYROLL_MANUAL_ENTRY_LABEL_MAX_LENGTH,
    immutable: true,
  },
  amountCentavos: sensitiveField(),
  taxable: switchField,
  reducesTaxablePay: switchField,
  authorizedInWriting: switchField,
  countsAsBasicSalary: switchField,
  reason: {
    type: String,
    required: true,
    trim: true,
    minlength: 1,
    maxlength: PAYROLL_MANUAL_ENTRY_REASON_MAX_LENGTH,
    immutable: true,
  },
  supersedesId: { type: Schema.Types.ObjectId, default: null, immutable: true },
  removed: { type: Boolean, required: true, default: false, immutable: true },
});

const isBoolean = (value: unknown) => typeof value === 'boolean';
const isNull = (value: unknown) => value === null || value === undefined;

/** The switches each kind needs (decision 355); the message for the first broken rule, or null. */
export function manualEntryShapeError(entry: {
  kind?: unknown;
  targetLineKey?: unknown;
  taxable?: unknown;
  reducesTaxablePay?: unknown;
  authorizedInWriting?: unknown;
  countsAsBasicSalary?: unknown;
  supersedesId?: unknown;
  removed?: unknown;
  amountCentavos?: unknown;
}): string | null {
  if (entry.removed === true && isNull(entry.supersedesId)) {
    return 'A removal supersedes the entry it removes.';
  }
  if (entry.removed !== true && isNull(entry.amountCentavos)) {
    return 'A manual entry needs an amount.';
  }
  switch (entry.kind) {
    case 'earning':
      if (!isNull(entry.targetLineKey)) return 'Only an override names a computed line.';
      if (!isBoolean(entry.taxable) || !isBoolean(entry.countsAsBasicSalary)) {
        return 'An earning says whether it is taxable and whether it counts as basic salary.';
      }
      if (!isNull(entry.reducesTaxablePay) || !isNull(entry.authorizedInWriting)) {
        return 'Only a deduction reduces taxable pay or is authorized in writing.';
      }
      return null;
    case 'deduction':
      if (!isNull(entry.targetLineKey)) return 'Only an override names a computed line.';
      if (
        !isBoolean(entry.reducesTaxablePay) ||
        !isBoolean(entry.authorizedInWriting) ||
        !isBoolean(entry.countsAsBasicSalary)
      ) {
        return 'A deduction says whether it reduces taxable pay, whether it is authorized in writing and whether it counts as basic salary.';
      }
      if (entry.reducesTaxablePay === false && entry.authorizedInWriting !== true) {
        return 'An after-tax deduction must be authorized in writing by the employee or required by law.';
      }
      if (!isNull(entry.taxable)) return 'Only an earning is taxable or not.';
      return null;
    case 'override':
      if (typeof entry.targetLineKey !== 'string' || entry.targetLineKey.trim() === '') {
        return 'An override names the computed line it replaces.';
      }
      if (
        !isNull(entry.taxable) ||
        !isNull(entry.reducesTaxablePay) ||
        !isNull(entry.authorizedInWriting) ||
        !isNull(entry.countsAsBasicSalary)
      ) {
        return 'An override has no earning or deduction switches.';
      }
      return null;
    default:
      return 'Unknown manual entry kind.';
  }
}

payrollManualEntrySchema.pre('validate', function () {
  // Only a new entry: a loaded one is never saved (the guard refuses it), and its amount isn't
  // selected.
  if (!this.isNew) return;
  const error = manualEntryShapeError({
    kind: this.kind,
    targetLineKey: this.targetLineKey,
    taxable: this.taxable,
    reducesTaxablePay: this.reducesTaxablePay,
    authorizedInWriting: this.authorizedInWriting,
    countsAsBasicSalary: this.countsAsBasicSalary,
    supersedesId: this.supersedesId,
    removed: this.removed,
    amountCentavos: this.amountCentavos,
  });
  if (error) this.invalidate('kind', error);
});

payrollManualEntrySchema.index({ runId: 1, employeeId: 1, createdAt: 1 });
/** One entry per superseded entry: an edit or removal must supersede the latest of its chain. */
export const ONE_ENTRY_PER_SUPERSEDED_INDEX = 'onePayrollManualEntryPerSuperseded';
payrollManualEntrySchema.index(
  { supersedesId: 1 },
  {
    unique: true,
    name: ONE_ENTRY_PER_SUPERSEDED_INDEX,
    partialFilterExpression: { supersedesId: { $type: 'objectId' } },
  },
);

guardInsertsForEditableRuns(
  payrollManualEntrySchema,
  'Manual entries are never changed or deleted. Add an entry that supersedes the latest one instead.',
  'Manual entries are added only to a draft or returned payroll run.',
);

payrollManualEntrySchema.plugin(baseSchemaPlugin, { softDelete: false });

export const PayrollManualEntryModel = defineModel(
  'PayrollManualEntry',
  payrollManualEntrySchema,
  'payrollManualEntries',
);

// ---------------------------------------------------------------------------------------------
// payrollFlagAcknowledgements

export interface PayrollFlagAcknowledgementDocument {
  _id: Types.ObjectId;
  runId: Types.ObjectId;
  employeeId: Types.ObjectId;
  flag: AcknowledgeablePayrollFlag;
  /** 1 to 300 characters, plain. */
  reason: string;
  createdAt: Date;
  updatedAt: Date;
  createdBy: Types.ObjectId | null;
  updatedBy: Types.ObjectId | null;
}

const payrollFlagAcknowledgementSchema = new Schema<PayrollFlagAcknowledgementDocument>({
  runId: { type: Schema.Types.ObjectId, required: true, immutable: true },
  employeeId: { type: Schema.Types.ObjectId, required: true, immutable: true },
  flag: { type: String, enum: ACKNOWLEDGEABLE_PAYROLL_FLAGS, required: true, immutable: true },
  reason: {
    type: String,
    required: true,
    trim: true,
    minlength: 1,
    maxlength: PAYROLL_FLAG_ACKNOWLEDGEMENT_REASON_MAX_LENGTH,
    immutable: true,
  },
});

/** One acknowledgement per run, employee and flag. */
export const ONE_ACKNOWLEDGEMENT_PER_FLAG_INDEX = 'onePayrollFlagAcknowledgement';
payrollFlagAcknowledgementSchema.index(
  { runId: 1, employeeId: 1, flag: 1 },
  { unique: true, name: ONE_ACKNOWLEDGEMENT_PER_FLAG_INDEX },
);

guardInsertsForEditableRuns(
  payrollFlagAcknowledgementSchema,
  'Flag acknowledgements are never changed or deleted.',
  'Flags are acknowledged only on a draft or returned payroll run.',
);

payrollFlagAcknowledgementSchema.plugin(baseSchemaPlugin, { softDelete: false });

export const PayrollFlagAcknowledgementModel = defineModel(
  'PayrollFlagAcknowledgement',
  payrollFlagAcknowledgementSchema,
  'payrollFlagAcknowledgements',
);
