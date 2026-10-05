import { Schema, type Types } from 'mongoose';
import { baseSchemaPlugin, defineModel } from '@pulse/db';
import { EMPLOYMENT_STATUS, EMPLOYMENT_STATUSES, type EmploymentStatus } from '../../account';
import { startOfBusinessDate, toBusinessDate } from '../../dates';
import { EMPLOYEE_NUMBER_PATTERN } from '../../employee-number';
import { EMPLOYEE_NAME_MAX_LENGTH, SEPARATION_BEFORE_HIRE } from '../../user-accounts';

// Spec: docs/modules/core.md#people-data-ownership — the employee identity Core owns: name,
// employee number, department, position, reporting lines, employment status and separation date.
// Pulse Talent owns the rest of the employee record under the same `employeeId` (Phase 2).
// Numbers are issued and reporting lines validated by the user service (build step 1.5).

export interface EmployeeRecord {
  _id: Types.ObjectId;
  /** `YYYY-NN`, assigned once and never changed (docs/modules/core.md#employee-number-company-id). */
  employeeNumber: string;
  firstName: string;
  middleName: string | null;
  lastName: string;
  departmentId: Types.ObjectId;
  positionId: Types.ObjectId;
  /** Supervisors; may be empty (docs/modules/core.md#reporting-lines). */
  reportingTo: Types.ObjectId[];
  employmentStatus: EmploymentStatus;
  /** 00:00 Manila on the hire date, stored in UTC (docs/DATA_MODEL.md#general). */
  dateHired: Date;
  /**
   * 00:00 Manila on the separation date, stored in UTC. Set for a separated employment status,
   * null for an active one (SECURITY.md#account-status).
   */
  separationDate: Date | null;
  createdAt: Date;
  updatedAt: Date;
  createdBy: Types.ObjectId | null;
  updatedBy: Types.ObjectId | null;
}

const nameField = { type: String, required: true, trim: true, maxlength: EMPLOYEE_NAME_MAX_LENGTH };

const employeeSchema = new Schema<EmployeeRecord>({
  employeeNumber: {
    type: String,
    required: true,
    immutable: true,
    match: [EMPLOYEE_NUMBER_PATTERN, 'An employee number is YYYY-NN, for example 2027-01.'],
  },
  firstName: nameField,
  middleName: { type: String, default: null, trim: true, maxlength: EMPLOYEE_NAME_MAX_LENGTH },
  lastName: nameField,
  departmentId: { type: Schema.Types.ObjectId, required: true },
  positionId: { type: Schema.Types.ObjectId, required: true },
  reportingTo: { type: [Schema.Types.ObjectId], default: [] },
  employmentStatus: { type: String, required: true, enum: EMPLOYMENT_STATUSES },
  dateHired: { type: Date, required: true },
  separationDate: { type: Date, default: null },
});

employeeSchema.index({ employeeNumber: 1 }, { unique: true });
employeeSchema.index({ departmentId: 1 });
employeeSchema.index({ positionId: 1 });
// Finds an employee's direct reports (approvals, org chart).
employeeSchema.index({ reportingTo: 1 });

/** True when `instant` is 00:00 Manila on its day, as every business date is stored. */
function isStartOfManilaDay(instant: Date): boolean {
  return startOfBusinessDate(toBusinessDate(instant)).getTime() === instant.getTime();
}

// Spec: SECURITY.md#account-status — the separation date's shape: required for a separated
// status, null for an active one, at 00:00 Manila, and not before the date hired. "Today or
// earlier" depends on the clock, so the user service checks it, not the schema. Like every
// document validator this runs on create and save, not on `updateOne`: services that change the
// status or either date go through a document, or check the same rules themselves.
employeeSchema.pre('validate', function () {
  const status = this.employmentStatus as string;
  if (!Object.hasOwn(EMPLOYMENT_STATUS, status)) return; // The enum check reports it.
  const separated = EMPLOYMENT_STATUS[status as EmploymentStatus] === 'deactivated';
  const date = this.separationDate;
  if (!separated) {
    if (date !== null) {
      this.invalidate('separationDate', 'Only a separated employee has a separation date.');
    }
    return;
  }
  if (date === null) {
    this.invalidate('separationDate', 'Enter the separation date.');
  } else if (Number.isNaN(date.getTime()) || !isStartOfManilaDay(date)) {
    this.invalidate('separationDate', 'Enter the separation date as a calendar day.');
  } else if (this.dateHired instanceof Date && date.getTime() < this.dateHired.getTime()) {
    this.invalidate('separationDate', SEPARATION_BEFORE_HIRE);
  }
});

// Employee records are never deleted (docs/DATA_MODEL.md#locked-and-append-only-records).
employeeSchema.plugin(baseSchemaPlugin, { softDelete: false });

export const EmployeeModel = defineModel('Employee', employeeSchema, 'employees');
