import { Schema, type Types } from 'mongoose';
import { baseSchemaPlugin, defineModel } from '@pulse/db';
import { guardWrites } from '@pulse/core/server';
import {
  LEAVE_ENTRY_KINDS,
  LEAVE_ENTRY_REASON_MAX_LENGTH,
  type LeaveEntryKind,
} from '../../time-off/kinds';

// Spec: docs/DATA_MODEL.md#collection-ownership (`leaveEntries`, build step 2.8) and
// docs/modules/talent.md#leave-offset-time-off-and-opening-balances-build-step-28 ("Leave
// entries"; decisions 303–305 and 307 in docs/BUILD_PLAN.md).
//
// - Insert-only, like `offsetEntries`: no update and no delete, ever. A correction is a new
//   `adjustment`. A type's balance is the sum of the employee's `halfDays` for it, never stored.
// - `credited` types only (VL and SL when seeded); `perEvent` and `perYear` types have no entries.
// - One `opening` per employee and type, and one `credit` and one `carryOver` per employee, type
//   and year (the credit job's idempotence), by partial unique indexes.
// - Written only by Talent's leave service (./service.ts), the credit job (./credits.ts) and the
//   opening balance service.

export interface LeaveEntryDocument {
  _id: Types.ObjectId;
  employeeId: Types.ObjectId;
  /** A `credited` type's key in `talent.leaveSettings`. */
  typeKey: string;
  kind: LeaveEntryKind;
  /** Signed whole half days: an opening 0 or more, a credit above 0, a carry-over 0 or less. */
  halfDays: number;
  /** 00:00 Manila on the day it counts from. */
  effectiveOn: Date;
  /** The credit's or carry-over's year; null for the other kinds. */
  year: number | null;
  /** `talent.timeOffRequest` and its id on a usage, or on the listener's adjustment; else null. */
  sourceType: string | null;
  sourceId: Types.ObjectId | null;
  /** Required on HR's adjustment; null otherwise. */
  reason: string | null;
  createdAt: Date;
  updatedAt: Date;
  /** Null for the system (the credit job and the listener). */
  createdBy: Types.ObjectId | null;
  updatedBy: Types.ObjectId | null;
}

const leaveEntrySchema = new Schema<LeaveEntryDocument>({
  employeeId: { type: Schema.Types.ObjectId, required: true, immutable: true },
  typeKey: { type: String, required: true, trim: true, maxlength: 40, immutable: true },
  kind: { type: String, enum: LEAVE_ENTRY_KINDS, required: true, immutable: true },
  halfDays: {
    type: Number,
    required: true,
    immutable: true,
    validate: { validator: Number.isSafeInteger, message: 'Leave is counted in whole half days.' },
  },
  effectiveOn: { type: Date, required: true, immutable: true },
  year: {
    type: Number,
    default: null,
    immutable: true,
    validate: {
      validator: (value: number | null) => value === null || Number.isSafeInteger(value),
      message: 'A year is a whole number.',
    },
  },
  sourceType: { type: String, default: null, immutable: true },
  sourceId: { type: Schema.Types.ObjectId, default: null, immutable: true },
  reason: {
    type: String,
    default: null,
    trim: true,
    maxlength: LEAVE_ENTRY_REASON_MAX_LENGTH,
    immutable: true,
  },
});

leaveEntrySchema.index({ employeeId: 1, typeKey: 1, effectiveOn: 1 });
leaveEntrySchema.index({ sourceType: 1, sourceId: 1 });
/** The unique index's name: one opening per employee and type. */
export const ONE_LEAVE_OPENING_INDEX = 'oneLeaveOpening';
leaveEntrySchema.index(
  { employeeId: 1, typeKey: 1 },
  { unique: true, name: ONE_LEAVE_OPENING_INDEX, partialFilterExpression: { kind: 'opening' } },
);
/**
 * The unique index's name: one credit and one carry-over per employee, type and year. Only those
 * two kinds carry a year, so the partial filter on a numeric year picks them.
 */
export const ONE_LEAVE_CREDIT_PER_YEAR_INDEX = 'oneLeaveCreditPerYear';
leaveEntrySchema.index(
  { employeeId: 1, typeKey: 1, kind: 1, year: 1 },
  {
    unique: true,
    name: ONE_LEAVE_CREDIT_PER_YEAR_INDEX,
    partialFilterExpression: { year: { $type: 'number' } },
  },
);

guardWrites(leaveEntrySchema, {
  message: 'Leave entries are never changed or deleted. Add an adjustment instead.',
});

leaveEntrySchema.plugin(baseSchemaPlugin, { softDelete: false });

export const LeaveEntryModel = defineModel('LeaveEntry', leaveEntrySchema, 'leaveEntries');
