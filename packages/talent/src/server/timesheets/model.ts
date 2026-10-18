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
  RETURN_REMARKS_MAX_LENGTH,
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
//   transactions touching the same timesheet always conflict and one retries). Never deleted.
// - Step 2.7 (docs/modules/talent.md#timesheet-approval-the-dtr-and-the-offset-balance-build-step-27,
//   decisions 278 and 283): the statuses and the submission and approval fields, each null until
//   set. The guard also lets through a `$set` of those fields, which only the timesheet service
//   (submit) and its approval hooks write. The `{ periodStart, status }` index serves the
//   timesheets list and the reminders.
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
  /** Step 2.7: the latest submit. */
  submittedAt: Date | null;
  /** Step 2.7: the current Core approval request. */
  approvalRequestId: Types.ObjectId | null;
  supervisorApprovedAt: Date | null;
  /** The supervisor's user id. */
  supervisorApprovedBy: Types.ObjectId | null;
  /** HR's approval (user id). */
  approvedAt: Date | null;
  approvedBy: Types.ObjectId | null;
  /** The latest return (user id and remarks). */
  returnedAt: Date | null;
  returnedBy: Types.ObjectId | null;
  returnRemarks: string | null;
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
  submittedAt: { type: Date, default: null },
  approvalRequestId: { type: Schema.Types.ObjectId, default: null },
  supervisorApprovedAt: { type: Date, default: null },
  supervisorApprovedBy: { type: Schema.Types.ObjectId, default: null },
  approvedAt: { type: Date, default: null },
  approvedBy: { type: Schema.Types.ObjectId, default: null },
  returnedAt: { type: Date, default: null },
  returnedBy: { type: Schema.Types.ObjectId, default: null },
  returnRemarks: {
    type: String,
    default: null,
    trim: true,
    minlength: 1,
    maxlength: RETURN_REMARKS_MAX_LENGTH,
  },
});

timesheetSchema.index({ employeeId: 1, periodStart: 1 }, { unique: true });
timesheetSchema.index({ periodStart: 1, status: 1 });

const TOUCH_KEYS = ['updatedAt', 'updatedBy'] as const;
/** The step 2.7 fields only the timesheet service and its approval hooks set (decision 283). */
const STATUS_KEYS = [
  'status',
  'submittedAt',
  'approvalRequestId',
  'supervisorApprovedAt',
  'supervisorApprovedBy',
  'approvedAt',
  'approvedBy',
  'returnedAt',
  'returnedBy',
  'returnRemarks',
] as const;
const SET_KEYS = new Set<string>([...TOUCH_KEYS, ...STATUS_KEYS]);
const UPDATE_OPERATORS = new Set(['$set', '$setOnInsert', '$inc']);
guardWrites(timesheetSchema, {
  message: 'A timesheet’s period and type are never changed, and a timesheet is never deleted.',
  // The time entry and reimbursement services touch the timesheet (updatedAt, updatedBy, and `__v`
  // incremented so the write always happens) in each save's transaction. From step 2.7 the
  // timesheet service (submit) and its approval hooks also set the status fields.
  allowUpdate: (update) =>
    hasOnlyKeys(update, UPDATE_OPERATORS) &&
    hasOnlyKeys(update.$set ?? {}, SET_KEYS) &&
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
