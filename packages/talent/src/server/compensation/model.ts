import { Schema, type Types } from 'mongoose';
import { baseSchemaPlugin, defineModel } from '@pulse/db';
import { guardWrites, sensitiveField } from '@pulse/core/server';
import { RATE_TYPES, type RateType } from '../../fixed-sets';
import { COMPENSATION_REASON_MAX_LENGTH } from '../../validation';

// Spec: docs/DATA_MODEL.md#collection-ownership and #locked-and-append-only-records,
// docs/modules/talent.md#the-employee-record-build-step-21 (decision 163 in docs/BUILD_PLAN.md) —
// the append-only salary history. Insert-only: every update, replacement and delete is refused. A
// correction is a new entry with the same effective date; the newest created wins that date.
// The basic salary (whole centavos) is a `sensitiveField()`, encrypted with `encryptSensitive`.

export interface CompensationEntryDocument {
  _id: Types.ObjectId;
  employeeId: Types.ObjectId;
  /** 00:00 Manila on the effective date, stored in UTC. */
  effectiveDate: Date;
  /** The encrypted whole number of centavos. */
  basicSalaryCentavos: Buffer;
  rateType: RateType;
  minimumWageEarner: boolean;
  reason: string;
  /** True when HR chose "Save anyway" on the minimum wage warning (step 2.3); absent reads as false. */
  minimumWageWarningConfirmed?: boolean;
  createdAt: Date;
  updatedAt: Date;
  createdBy: Types.ObjectId | null;
  updatedBy: Types.ObjectId | null;
}

const compensationEntrySchema = new Schema<CompensationEntryDocument>({
  employeeId: { type: Schema.Types.ObjectId, required: true, immutable: true },
  effectiveDate: { type: Date, required: true, immutable: true },
  basicSalaryCentavos: sensitiveField({ required: true }),
  rateType: { type: String, enum: RATE_TYPES, required: true, immutable: true },
  minimumWageEarner: { type: Boolean, required: true, immutable: true },
  reason: {
    type: String,
    required: true,
    trim: true,
    minlength: 1,
    maxlength: COMPENSATION_REASON_MAX_LENGTH,
    immutable: true,
  },
  // Step 2.3 (decision 205). No default, so entries saved before step 2.3 keep lacking it.
  minimumWageWarningConfirmed: { type: Boolean, immutable: true },
});

compensationEntrySchema.index({ employeeId: 1, effectiveDate: -1, createdAt: -1 });

guardWrites(compensationEntrySchema, {
  message:
    'Compensation entries are never changed or deleted. To correct one, add a new entry with the same effective date.',
});

// Append-only, so no soft delete.
compensationEntrySchema.plugin(baseSchemaPlugin, { softDelete: false });

export const CompensationEntryModel = defineModel(
  'CompensationEntry',
  compensationEntrySchema,
  'compensationEntries',
);
