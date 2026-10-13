import { Schema, type Types } from 'mongoose';
import { baseSchemaPlugin, defineModel } from '@pulse/db';
import { guardWrites } from '@pulse/core/server';
import {
  BREAK_MINUTES_MAX,
  GRACE_MINUTES_MAX,
  SCHEDULE_REASON_MAX_LENGTH,
  type WorkSchedule,
} from '../../timesheets/schemas';

// Spec: docs/DATA_MODEL.md#collection-ownership ("Timesheet collections", build step 2.4) and
// docs/modules/talent.md#work-schedules-and-daily-time-entries-build-step-24 (decision 215 in
// docs/BUILD_PLAN.md) — employees' own work schedules. Insert-only: every update, replacement and
// delete is refused. A correction is a new entry; the latest one on or before a day wins (on a
// tie, the newest). A null schedule means "back to the company default".

export interface WorkScheduleAssignmentDocument {
  _id: Types.ObjectId;
  employeeId: Types.ObjectId;
  /** 00:00 Manila on the effective date, stored in UTC. */
  effectiveFrom: Date;
  schedule: WorkSchedule | null;
  reason: string;
  createdAt: Date;
  updatedAt: Date;
  createdBy: Types.ObjectId | null;
  updatedBy: Types.ObjectId | null;
}

const TIME = /^(?:[01]\d|2[0-3]):[0-5]\d$/;

const scheduleSchema = new Schema<WorkSchedule>(
  {
    workDays: {
      type: [{ type: Number, min: 1, max: 7 }],
      required: true,
      validate: (days: number[]) => days.length >= 1 && days.length <= 7,
    },
    start: { type: String, required: true, match: TIME },
    end: { type: String, required: true, match: TIME },
    breakStart: { type: String, required: true, match: TIME },
    breakMinutes: { type: Number, required: true, min: 0, max: BREAK_MINUTES_MAX },
    graceMinutes: { type: Number, required: true, min: 0, max: GRACE_MINUTES_MAX },
  },
  { _id: false },
);

const workScheduleAssignmentSchema = new Schema<WorkScheduleAssignmentDocument>({
  employeeId: { type: Schema.Types.ObjectId, required: true, immutable: true },
  effectiveFrom: { type: Date, required: true, immutable: true },
  schedule: { type: scheduleSchema, default: null, immutable: true },
  reason: {
    type: String,
    required: true,
    trim: true,
    minlength: 1,
    maxlength: SCHEDULE_REASON_MAX_LENGTH,
    immutable: true,
  },
});

workScheduleAssignmentSchema.index({ employeeId: 1, effectiveFrom: 1, createdAt: 1 });

guardWrites(workScheduleAssignmentSchema, {
  message:
    'Work schedule assignments are never changed or deleted. To change a schedule, set a new one.',
});

// Insert-only, so no soft delete.
workScheduleAssignmentSchema.plugin(baseSchemaPlugin, { softDelete: false });

export const WorkScheduleAssignmentModel = defineModel(
  'WorkScheduleAssignment',
  workScheduleAssignmentSchema,
  'workScheduleAssignments',
);
