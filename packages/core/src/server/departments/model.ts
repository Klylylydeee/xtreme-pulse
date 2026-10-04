import { Schema, type Types } from 'mongoose';
import { baseSchemaPlugin, defineModel } from '@pulse/db';
import {
  DEPARTMENT_CODE_HELP,
  DEPARTMENT_CODE_PATTERN,
  DEPARTMENT_NAME_MAX_LENGTH,
} from '../../org-structure';

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

// The pattern lives in the pure org-structure module, so the form checks the same rule.
export { DEPARTMENT_CODE_PATTERN };

const departmentSchema = new Schema<DepartmentRecord>({
  name: { type: String, required: true, trim: true, maxlength: DEPARTMENT_NAME_MAX_LENGTH },
  code: {
    type: String,
    required: true,
    trim: true,
    uppercase: true,
    immutable: true,
    match: [DEPARTMENT_CODE_PATTERN, DEPARTMENT_CODE_HELP],
  },
  headEmployeeId: { type: Schema.Types.ObjectId, default: null },
});

// A retired department keeps its code, so the code is never reused for another department.
departmentSchema.index({ code: 1 }, { unique: true });

// Retiring a department soft-deletes it.
departmentSchema.plugin(baseSchemaPlugin, { softDelete: true });

export const DepartmentModel = defineModel('Department', departmentSchema, 'departments');
