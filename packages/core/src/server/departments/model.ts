import { Schema, type Types } from 'mongoose';
import { baseSchemaPlugin, defineModel } from '@pulse/db';

// Spec: docs/modules/core.md#departments-and-positions — departments are data, managed by HR and
// the System Administrator (screens in build step 1.4). The code is fixed once created: the HR,
// Accounting and Board roles follow the `HR`, `ACCT` and `BOD` codes (SECURITY.md#roles).

export interface DepartmentRecord {
  _id: Types.ObjectId;
  name: string;
  /** Short uppercase code, for example `HR`. Never changes. */
  code: string;
  /** The department head, who receives escalations; null when none is set. */
  headEmployeeId: Types.ObjectId | null;
  createdAt: Date;
  updatedAt: Date;
  createdBy: Types.ObjectId | null;
  updatedBy: Types.ObjectId | null;
  deletedAt: Date | null;
}

export const DEPARTMENT_CODE_PATTERN = /^[A-Z][A-Z0-9]{1,9}$/;

const departmentSchema = new Schema<DepartmentRecord>({
  name: { type: String, required: true, trim: true, maxlength: 100 },
  code: {
    type: String,
    required: true,
    trim: true,
    uppercase: true,
    immutable: true,
    match: [
      DEPARTMENT_CODE_PATTERN,
      'Use 2 to 10 capital letters or digits, starting with a letter.',
    ],
  },
  headEmployeeId: { type: Schema.Types.ObjectId, default: null },
});

// A retired department keeps its code, so the code is never reused for another department.
departmentSchema.index({ code: 1 }, { unique: true });

// Retiring a department soft-deletes it.
departmentSchema.plugin(baseSchemaPlugin, { softDelete: true });

export const DepartmentModel = defineModel('Department', departmentSchema, 'departments');
