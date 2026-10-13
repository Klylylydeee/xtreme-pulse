import { Schema, type Types } from 'mongoose';
import { baseSchemaPlugin, defineModel } from '@pulse/db';
import { TIMESHEET_TYPES, type TimesheetType } from '@pulse/core';
import { guardWrites, hasOnlyKeys } from '@pulse/core/server';
import { CUT_OFF_KEYS, type CutOffKey } from '../../payroll/schemas';
import {
  EXTRA_HOURS_REASON_MAX_LENGTH,
  TIME_ENTRY_ACTIVITY_MAX_LENGTH,
  TIME_ENTRY_SOURCES,
  type TimeEntrySource,
  TIMESHEET_STATUSES,
  type TimesheetStatus,
} from '../../timesheets/schemas';

// Spec: docs/DATA_MODEL.md#collection-ownership ("Timesheet collections", build step 2.4) and
// docs/modules/talent.md#work-schedules-and-daily-time-entries-build-step-24 (decisions 217–220 in
// docs/BUILD_PLAN.md).
//
// - `timesheets`: one per employee per cut-off (unique employee and period start). The type is
//   read once, when the timesheet is created, and never changed: the only update allowed touches
//   `updatedAt` and `updatedBy` and increments `__v`, which every time entry save does to
//   serialize an employee's concurrent saves (the increment makes it a real write, so two
//   transactions touching the same timesheet always conflict and one retries). Never deleted. Step 2.7 adds the other statuses.
// - `timeEntries`: the employee's own entries. Soft delete only; every save checks `version`.
//   No project or ticket field until Phases 4 and 6.

export interface TimesheetDocument {
  _id: Types.ObjectId;
  employeeId: Types.ObjectId;
  /** 00:00 Manila on each day, stored in UTC. */
  periodStart: Date;
  periodEnd: Date;
  payDate: Date;
  cutOffKey: CutOffKey;
  timesheetType: TimesheetType;
  /** 00:00 Manila on the day the type was read. */
  typeReadOn: Date;
  status: TimesheetStatus;
  createdAt: Date;
  updatedAt: Date;
  createdBy: Types.ObjectId | null;
  updatedBy: Types.ObjectId | null;
}

const timesheetSchema = new Schema<TimesheetDocument>({
  employeeId: { type: Schema.Types.ObjectId, required: true, immutable: true },
  periodStart: { type: Date, required: true, immutable: true },
  periodEnd: { type: Date, required: true, immutable: true },
  payDate: { type: Date, required: true, immutable: true },
  cutOffKey: { type: String, enum: CUT_OFF_KEYS, required: true, immutable: true },
  timesheetType: { type: String, enum: TIMESHEET_TYPES, required: true, immutable: true },
  typeReadOn: { type: Date, required: true, immutable: true },
  status: { type: String, enum: TIMESHEET_STATUSES, required: true, default: 'open' },
});

timesheetSchema.index({ employeeId: 1, periodStart: 1 }, { unique: true });
timesheetSchema.index({ periodStart: 1 });

const TOUCH_KEYS = new Set(['updatedAt', 'updatedBy']);
const UPDATE_OPERATORS = new Set(['$set', '$setOnInsert', '$inc']);
guardWrites(timesheetSchema, {
  message: 'A timesheet’s period and type are never changed, and a timesheet is never deleted.',
  // The time entry services touch the timesheet (updatedAt, updatedBy, and `__v` incremented so
  // the write always happens) in each save's transaction.
  allowUpdate: (update) =>
    hasOnlyKeys(update, UPDATE_OPERATORS) &&
    hasOnlyKeys(update.$set ?? {}, TOUCH_KEYS) &&
    hasOnlyKeys(update.$inc ?? {}, new Set(['__v'])) &&
    hasOnlyKeys(update.$setOnInsert ?? {}, new Set(['createdAt'])),
});

timesheetSchema.plugin(baseSchemaPlugin, { softDelete: false });

export const TimesheetModel = defineModel('Timesheet', timesheetSchema, 'timesheets');

export interface TimeEntryDocument {
  _id: Types.ObjectId;
  employeeId: Types.ObjectId;
  timesheetId: Types.ObjectId;
  /** 00:00 Manila on the day of the time in. */
  date: Date;
  timeIn: Date;
  timeOut: Date | null;
  timeInSource: TimeEntrySource;
  timeOutSource: TimeEntrySource | null;
  activity: string | null;
  clientId: Types.ObjectId | null;
  extraHours: { reason: string } | null;
  version: number;
  deletedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  createdBy: Types.ObjectId | null;
  updatedBy: Types.ObjectId | null;
}

const extraHoursSchema = new Schema<{ reason: string }>(
  {
    reason: {
      type: String,
      required: true,
      trim: true,
      minlength: 1,
      maxlength: EXTRA_HOURS_REASON_MAX_LENGTH,
    },
  },
  { _id: false },
);

const timeEntrySchema = new Schema<TimeEntryDocument>({
  employeeId: { type: Schema.Types.ObjectId, required: true, immutable: true },
  timesheetId: { type: Schema.Types.ObjectId, required: true },
  date: { type: Date, required: true },
  timeIn: { type: Date, required: true },
  timeOut: { type: Date, default: null },
  timeInSource: { type: String, enum: TIME_ENTRY_SOURCES, required: true },
  timeOutSource: { type: String, enum: [...TIME_ENTRY_SOURCES, null], default: null },
  activity: {
    type: String,
    default: null,
    trim: true,
    minlength: 1,
    maxlength: TIME_ENTRY_ACTIVITY_MAX_LENGTH,
  },
  clientId: { type: Schema.Types.ObjectId, default: null },
  extraHours: { type: extraHoursSchema, default: null },
  version: { type: Number, required: true, min: 1 },
});

timeEntrySchema.index({ employeeId: 1, date: 1 });
timeEntrySchema.index({ timesheetId: 1 });
timeEntrySchema.index({ employeeId: 1, timeIn: 1 });

timeEntrySchema.plugin(baseSchemaPlugin, { softDelete: true });

export const TimeEntryModel = defineModel('TimeEntry', timeEntrySchema, 'timeEntries');
