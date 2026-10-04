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
  // A position's department is fixed once created (to move one, add a new position).
  departmentId: { type: Schema.Types.ObjectId, required: true, immutable: true },
  timesheetType: { type: String, required: true, enum: TIMESHEET_TYPES },
  seedKey: { type: String, default: null, immutable: true },
});

/** Position names are compared ignoring case, so `Driver` and `driver` can't both exist. */
export const POSITION_NAME_COLLATION = { locale: 'en', strength: 2 } as const;

/**
 * The name of the unique `{ departmentId, name }` index. It was case-sensitive under the default
 * name `departmentId_1_name_1`; the case-insensitive one has its own name, so a database that
 * still has the old index builds the new one beside it instead of failing with an options
 * conflict. `pnpm seed:admin` then drops the old one ({@link LEGACY_POSITION_NAME_INDEX}).
 */
export const POSITION_NAME_INDEX = 'departmentId_1_name_1_ci';
/** The earlier case-sensitive index, dropped by `pnpm seed:admin` where it still exists. */
export const LEGACY_POSITION_NAME_INDEX = 'departmentId_1_name_1';

// Retired positions are included, so a retired position's name isn't reused in its department.
positionSchema.index(
  { departmentId: 1, name: 1 },
  { unique: true, name: POSITION_NAME_INDEX, collation: POSITION_NAME_COLLATION },
);
positionSchema.index(
  { seedKey: 1 },
  { unique: true, partialFilterExpression: { seedKey: { $type: 'string' } } },
);

// Retiring a position soft-deletes it.
positionSchema.plugin(baseSchemaPlugin, { softDelete: true });

export const PositionModel = defineModel('Position', positionSchema, 'positions');
