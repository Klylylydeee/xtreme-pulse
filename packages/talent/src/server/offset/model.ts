import { Schema, type Types } from 'mongoose';
import { baseSchemaPlugin, defineModel } from '@pulse/db';
import { guardWrites } from '@pulse/core/server';
import {
  OFFSET_ENTRY_KINDS,
  OFFSET_ENTRY_REASON_MAX_LENGTH,
  type OffsetEntryKind,
} from '../../offset/entries';

// Spec: docs/DATA_MODEL.md#collection-ownership (`offsetEntries`, build step 2.7) and
// docs/modules/talent.md#timesheet-approval-the-dtr-and-the-offset-balance-build-step-27 ("The
// offset balance"; decisions 286 and 287 in docs/BUILD_PLAN.md).
//
// - Insert-only: no update and no delete, ever. A correction is a new entry. The balance is the sum
//   of an employee's `minutes` and is never stored.
// - Step 2.7 writes `credit` (HR's approval, in the decision's transaction) and `adjustment` (the
//   holidays-changed listener); step 2.8 writes `opening` and `usage`.
// - One `credit` per timesheet, by a partial unique index.

export interface OffsetEntryDocument {
  _id: Types.ObjectId;
  employeeId: Types.ObjectId;
  kind: OffsetEntryKind;
  /** Signed whole minutes; a credit is 0 or more. */
  minutes: number;
  /** 00:00 Manila on the day it counts from. */
  effectiveOn: Date;
  /** The timesheet of a credit or an adjustment; null otherwise. */
  timesheetId: Types.ObjectId | null;
  /** Step 2.8's usage points at its request; null in step 2.7. */
  sourceType: string | null;
  sourceId: Types.ObjectId | null;
  reason: string | null;
  createdAt: Date;
  updatedAt: Date;
  /** Null for the system (the listener). */
  createdBy: Types.ObjectId | null;
  updatedBy: Types.ObjectId | null;
}

const offsetEntrySchema = new Schema<OffsetEntryDocument>({
  employeeId: { type: Schema.Types.ObjectId, required: true, immutable: true },
  kind: { type: String, enum: OFFSET_ENTRY_KINDS, required: true, immutable: true },
  minutes: {
    type: Number,
    required: true,
    immutable: true,
    validate: { validator: Number.isSafeInteger, message: 'Offset minutes are whole minutes.' },
  },
  effectiveOn: { type: Date, required: true, immutable: true },
  timesheetId: { type: Schema.Types.ObjectId, default: null, immutable: true },
  sourceType: { type: String, default: null, immutable: true },
  sourceId: { type: Schema.Types.ObjectId, default: null, immutable: true },
  reason: {
    type: String,
    default: null,
    trim: true,
    maxlength: OFFSET_ENTRY_REASON_MAX_LENGTH,
    immutable: true,
  },
});

offsetEntrySchema.index({ employeeId: 1, effectiveOn: 1 });
offsetEntrySchema.index({ timesheetId: 1, kind: 1 });
/** The unique index's name: a timesheet is credited once. */
export const ONE_CREDIT_PER_TIMESHEET_INDEX = 'oneCreditPerTimesheet';
offsetEntrySchema.index(
  { timesheetId: 1 },
  {
    unique: true,
    name: ONE_CREDIT_PER_TIMESHEET_INDEX,
    partialFilterExpression: { kind: 'credit' },
  },
);

guardWrites(offsetEntrySchema, {
  message: 'Offset entries are never changed or deleted. Add a new entry instead.',
});

offsetEntrySchema.plugin(baseSchemaPlugin, { softDelete: false });

export const OffsetEntryModel = defineModel('OffsetEntry', offsetEntrySchema, 'offsetEntries');
