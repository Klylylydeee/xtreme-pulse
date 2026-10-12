import { Schema, type Types } from 'mongoose';
import { baseSchemaPlugin, defineModel } from '@pulse/db';
import { guardWrites, sensitiveField } from '@pulse/core/server';
import { ALLOWANCE_ASSIGNMENT_KINDS, type AllowanceAssignmentKind } from '../../payroll/allowances';
import { ALLOWANCE_REASON_MAX_LENGTH } from '../../payroll/validation';

// Spec: docs/DATA_MODEL.md#collection-ownership ("Allowances", build step 2.3) and
// docs/modules/talent.md#payroll-settings-and-allowances-build-step-23 (decisions 203 and 204 in
// docs/BUILD_PLAN.md) — explicit allowance assignments. Insert-only: every update, replacement
// and delete is refused. The amount (whole centavos, in the type's basis) is a `sensitiveField()`,
// encrypted with `encryptSensitive`; an `end` entry has none (the field is absent).

export interface AllowanceAssignmentDocument {
  _id: Types.ObjectId;
  employeeId: Types.ObjectId;
  typeKey: string;
  /** 00:00 Manila on the effective date, stored in UTC. */
  effectiveDate: Date;
  kind: AllowanceAssignmentKind;
  /** The encrypted whole number of centavos; absent for `end`. */
  amountCentavos?: Buffer;
  reason: string;
  createdAt: Date;
  updatedAt: Date;
  createdBy: Types.ObjectId | null;
  updatedBy: Types.ObjectId | null;
}

const allowanceAssignmentSchema = new Schema<AllowanceAssignmentDocument>({
  employeeId: { type: Schema.Types.ObjectId, required: true, immutable: true },
  typeKey: { type: String, required: true, trim: true, maxlength: 40, immutable: true },
  effectiveDate: { type: Date, required: true, immutable: true },
  kind: { type: String, enum: ALLOWANCE_ASSIGNMENT_KINDS, required: true, immutable: true },
  amountCentavos: sensitiveField(),
  reason: {
    type: String,
    required: true,
    trim: true,
    minlength: 1,
    maxlength: ALLOWANCE_REASON_MAX_LENGTH,
    immutable: true,
  },
});

allowanceAssignmentSchema.index({ employeeId: 1, typeKey: 1, effectiveDate: -1, createdAt: -1 });

guardWrites(allowanceAssignmentSchema, {
  message:
    'Allowance assignments are never changed or deleted. To change one, add a new assignment.',
});

// Insert-only, so no soft delete.
allowanceAssignmentSchema.plugin(baseSchemaPlugin, { softDelete: false });

export const AllowanceAssignmentModel = defineModel(
  'AllowanceAssignment',
  allowanceAssignmentSchema,
  'allowanceAssignments',
);
