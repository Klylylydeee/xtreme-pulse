import { Schema, type Types } from 'mongoose';
import { baseSchemaPlugin, defineModel } from '@pulse/db';
import { EMPLOYMENT_STATUSES, type EmploymentStatus } from '../../account';
import { EMPLOYEE_NUMBER_PATTERN } from '../../employee-number';

// Spec: docs/modules/core.md#people-data-ownership — the employee identity Core owns: name,
// employee number, department, position, reporting lines and employment status. Pulse Talent owns
// the rest of the employee record under the same `employeeId` (Phase 2).
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
  /** Supervisors; empty only for top-level Board members (docs/modules/core.md#reporting-lines). */
  reportingTo: Types.ObjectId[];
  employmentStatus: EmploymentStatus;
  /** 00:00 Manila on the hire date, stored in UTC (docs/DATA_MODEL.md#general). */
  dateHired: Date;
  createdAt: Date;
  updatedAt: Date;
  createdBy: Types.ObjectId | null;
  updatedBy: Types.ObjectId | null;
}

const MAX_NAME_LENGTH = 100;

const nameField = { type: String, required: true, trim: true, maxlength: MAX_NAME_LENGTH };

const employeeSchema = new Schema<EmployeeRecord>({
  employeeNumber: {
    type: String,
    required: true,
    immutable: true,
    match: [EMPLOYEE_NUMBER_PATTERN, 'An employee number is YYYY-NN, for example 2027-01.'],
  },
  firstName: nameField,
  middleName: { type: String, default: null, trim: true, maxlength: MAX_NAME_LENGTH },
  lastName: nameField,
  departmentId: { type: Schema.Types.ObjectId, required: true },
  positionId: { type: Schema.Types.ObjectId, required: true },
  reportingTo: { type: [Schema.Types.ObjectId], default: [] },
  employmentStatus: { type: String, required: true, enum: EMPLOYMENT_STATUSES },
  dateHired: { type: Date, required: true },
});

employeeSchema.index({ employeeNumber: 1 }, { unique: true });
employeeSchema.index({ departmentId: 1 });
employeeSchema.index({ positionId: 1 });
// Finds an employee's direct reports (approvals, org chart).
employeeSchema.index({ reportingTo: 1 });

// Employee records are never deleted (docs/DATA_MODEL.md#locked-and-append-only-records).
employeeSchema.plugin(baseSchemaPlugin, { softDelete: false });

export const EmployeeModel = defineModel('Employee', employeeSchema, 'employees');
