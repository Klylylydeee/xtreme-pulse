import { Schema, type Types } from 'mongoose';
import { baseSchemaPlugin, defineModel } from '@pulse/db';
import { guardWrites, sensitiveField } from '@pulse/core/server';

// Spec: docs/DATA_MODEL.md#collection-ownership (`payrollOpeningEntries`, build step 2.8),
// docs/modules/talent.md#leave-offset-time-off-and-opening-balances-build-step-28 ("Opening
// balances") and SECURITY.md#sensitive-data (decision 308 in docs/BUILD_PLAN.md).
//
// - Year-to-date pay at go-live: seven figures for the year of `goLiveDate`, as of that date, each
//   a whole number of centavos, 0 or more, each a `sensitiveField()` (category `salary`),
//   encrypted with `encryptSensitive` and left out of queries unless selected. The collection
//   gets the `$jsonSchema` validator for its sensitive paths when its indexes are built.
// - Insert-only (`guardWrites`). A correction is a new entry with `supersedesId` and a reason; the
//   latest for an employee and year wins.
// - Written only by Talent's opening balance service (./service.ts). Steps 2.10 and 2.12 read it.

/** The audit record type and reveal owner type of a year-to-date pay entry. */
export const PAYROLL_OPENING_ENTRY_TYPE = 'talent.payrollOpeningEntry';

/** The seven figures, by field name (the reveal's field), in the order the page shows them. */
export const PAYROLL_OPENING_FIELDS = [
  'gross',
  'basicSalaryEarned',
  'taxableCompensation',
  'taxWithheld',
  'sssEmployee',
  'philhealthEmployee',
  'pagibigEmployee',
] as const;
export type PayrollOpeningField = (typeof PAYROLL_OPENING_FIELDS)[number];

export const PAYROLL_OPENING_FIELD_LABELS: Record<PayrollOpeningField, string> = {
  gross: 'Gross pay',
  basicSalaryEarned: 'Basic salary earned',
  taxableCompensation: 'Taxable compensation',
  taxWithheld: 'Tax withheld',
  sssEmployee: 'SSS employee share',
  philhealthEmployee: 'PhilHealth employee share',
  pagibigEmployee: 'Pag-IBIG employee share',
};

/** The stored path of a figure: `grossCentavos`, … */
export const payrollOpeningPath = (field: PayrollOpeningField) => `${field}Centavos` as const;
export type PayrollOpeningPath = ReturnType<typeof payrollOpeningPath>;

/** A correction's reason: 1 to 300 characters. */
export const PAYROLL_OPENING_REASON_MAX_LENGTH = 300;

export interface PayrollOpeningEntryDocument {
  _id: Types.ObjectId;
  employeeId: Types.ObjectId;
  /** The year of `asOf`. */
  year: number;
  /** 00:00 Manila on the go-live date. */
  asOf: Date;
  /** Each the encrypted whole number of centavos. */
  grossCentavos: Buffer;
  basicSalaryEarnedCentavos: Buffer;
  taxableCompensationCentavos: Buffer;
  taxWithheldCentavos: Buffer;
  sssEmployeeCentavos: Buffer;
  philhealthEmployeeCentavos: Buffer;
  pagibigEmployeeCentavos: Buffer;
  /** The entry this one corrects, or null for the first. */
  supersedesId: Types.ObjectId | null;
  /** Required on a correction; null on the first entry. */
  reason: string | null;
  createdAt: Date;
  updatedAt: Date;
  createdBy: Types.ObjectId | null;
  updatedBy: Types.ObjectId | null;
}

const payrollOpeningEntrySchema = new Schema<PayrollOpeningEntryDocument>({
  employeeId: { type: Schema.Types.ObjectId, required: true, immutable: true },
  year: {
    type: Number,
    required: true,
    immutable: true,
    validate: { validator: Number.isSafeInteger, message: 'A year is a whole number.' },
  },
  asOf: { type: Date, required: true, immutable: true },
  grossCentavos: sensitiveField({ required: true }),
  basicSalaryEarnedCentavos: sensitiveField({ required: true }),
  taxableCompensationCentavos: sensitiveField({ required: true }),
  taxWithheldCentavos: sensitiveField({ required: true }),
  sssEmployeeCentavos: sensitiveField({ required: true }),
  philhealthEmployeeCentavos: sensitiveField({ required: true }),
  pagibigEmployeeCentavos: sensitiveField({ required: true }),
  supersedesId: { type: Schema.Types.ObjectId, default: null, immutable: true },
  reason: {
    type: String,
    default: null,
    trim: true,
    minlength: 1,
    maxlength: PAYROLL_OPENING_REASON_MAX_LENGTH,
    immutable: true,
  },
});

payrollOpeningEntrySchema.index({ employeeId: 1, year: 1, createdAt: -1 });
/** One correction per entry: two people correcting the same entry at once can't both win. */
export const ONE_CORRECTION_PER_ENTRY_INDEX = 'oneCorrectionPerPayrollOpening';
payrollOpeningEntrySchema.index(
  { supersedesId: 1 },
  {
    unique: true,
    name: ONE_CORRECTION_PER_ENTRY_INDEX,
    partialFilterExpression: { supersedesId: { $type: 'objectId' } },
  },
);

/** One first entry per employee and year: a second one is a correction. */
export const ONE_FIRST_PAYROLL_OPENING_INDEX = 'oneFirstPayrollOpening';
payrollOpeningEntrySchema.index(
  { employeeId: 1, year: 1 },
  {
    unique: true,
    name: ONE_FIRST_PAYROLL_OPENING_INDEX,
    partialFilterExpression: { supersedesId: { $type: 'null' } },
  },
);

guardWrites(payrollOpeningEntrySchema, {
  message:
    'Year-to-date pay entries are never changed or deleted. Add a correction that supersedes the entry instead.',
});

payrollOpeningEntrySchema.plugin(baseSchemaPlugin, { softDelete: false });

export const PayrollOpeningEntryModel = defineModel(
  'PayrollOpeningEntry',
  payrollOpeningEntrySchema,
  'payrollOpeningEntries',
);
