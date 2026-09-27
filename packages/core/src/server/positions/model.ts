import { Schema, type Types } from 'mongoose';
import { baseSchemaPlugin, defineModel } from '@pulse/db';
import { TIMESHEET_TYPES, type TimesheetType } from '../../timesheet-types';

// Spec: docs/modules/core.md#departments-and-positions — positions are data, each in a department
// and with a timesheet type (docs/modules/talent.md#timesheet-types). A position carries no module
// access.

export interface PositionRecord {
  _id: Types.ObjectId;
  name: string;
  departmentId: Types.ObjectId;
  timesheetType: TimesheetType;
  /**
   * Set on positions the seed script created (`ADMIN.driver`), so a later run finds them even
   * after a rename. Null for positions added on the admin screens.
   */
  seedKey: string | null;
  createdAt: Date;
  updatedAt: Date;
  createdBy: Types.ObjectId | null;
  updatedBy: Types.ObjectId | null;
  deletedAt: Date | null;
}

const positionSchema = new Schema<PositionRecord>({
  name: { type: String, required: true, trim: true, maxlength: 100 },
  departmentId: { type: Schema.Types.ObjectId, required: true },
  timesheetType: { type: String, required: true, enum: TIMESHEET_TYPES },
  seedKey: { type: String, default: null, immutable: true },
});

positionSchema.index({ departmentId: 1, name: 1 }, { unique: true });
positionSchema.index(
  { seedKey: 1 },
  { unique: true, partialFilterExpression: { seedKey: { $type: 'string' } } },
);

// Retiring a position soft-deletes it.
positionSchema.plugin(baseSchemaPlugin, { softDelete: true });

export const PositionModel = defineModel('Position', positionSchema, 'positions');
