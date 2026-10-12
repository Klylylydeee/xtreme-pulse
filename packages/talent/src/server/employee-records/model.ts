import { Schema, type Types } from 'mongoose';
import { baseSchemaPlugin, defineModel } from '@pulse/db';
import { guardWrites, hasOnlyKeys, sensitiveField } from '@pulse/core/server';
import {
  CIVIL_STATUSES,
  type CivilStatus,
  DEFAULT_WORK_REGION,
  PAYROLL_BANKS,
  type PayrollBank,
  SEXES,
  type Sex,
  WORK_REGIONS,
  type WorkRegion,
} from '../../fixed-sets';
import { MOBILE_NUMBER_PATTERN, RDO_CODE_DIGITS } from '../../formats';
import {
  ACCOUNT_NAME_MAX_LENGTH,
  ADDRESS_MAX_LENGTH,
  EMERGENCY_CONTACT_NAME_MAX_LENGTH,
  EMERGENCY_CONTACT_RELATIONSHIP_MAX_LENGTH,
  NATIONALITY_MAX_LENGTH,
  PERSONAL_EMAIL_MAX_LENGTH,
  SEPARATION_REMARKS_MAX_LENGTH,
  SKILL_MAX_LENGTH,
  SKILLS_MAX_COUNT,
} from '../../validation';

// Spec: docs/DATA_MODEL.md#collection-ownership ("The Talent employee record") and
// docs/modules/talent.md#the-employee-record-build-step-21 (decisions 155 and 157 in
// docs/BUILD_PLAN.md) — one record per employee, keyed by Core's `employeeId` (unique), created on
// the first Talent save and never deleted. Core's identity fields stay in Core.
//
// - The TIN, SSS, PhilHealth PIN, Pag-IBIG MID and bank account number are `sensitiveField()`s:
//   encrypted with `encryptSensitive` before saving, refused in plain text by the model and by
//   the collection's `$jsonSchema` validator, and left out of queries unless selected.
// - Deletes and replacements are refused (guardWrites). The one allowed write after the insert is
//   an operator update ($set, $unset, $inc) through updateOne or findOneAndUpdate, which the
//   service makes with the `version` check.

export interface EmergencyContact {
  name: string | null;
  relationship: string | null;
  mobileNumber: string | null;
}

export interface EmployeeRecordDocument {
  _id: Types.ObjectId;
  employeeId: Types.ObjectId;
  dateOfBirth: Date | null;
  sex: Sex | null;
  civilStatus: CivilStatus | null;
  nationality: string | null;
  presentAddress: string | null;
  permanentAddress: string | null;
  mobileNumber: string | null;
  personalEmail: string | null;
  emergencyContact: EmergencyContact | null;
  workRegion: WorkRegion;
  contractEndDate: Date | null;
  regularizationDate: Date | null;
  separationRemarks: string | null;
  governmentIds: {
    tin?: Buffer;
    sss?: Buffer;
    philhealth?: Buffer;
    pagibig?: Buffer;
    rdoCode: string | null;
  };
  bankAccount: {
    bank: PayrollBank | null;
    accountNumber?: Buffer;
    accountName: string | null;
  };
  /** Skills tags (build step 2.2); absent on records saved before it. */
  skills?: string[];
  /** Raised by every save, for the stale-form check. */
  version: number;
  createdAt: Date;
  updatedAt: Date;
  createdBy: Types.ObjectId | null;
  updatedBy: Types.ObjectId | null;
}

/** Every sensitive path, for `.select()` when the stored values are needed (audit, last 4). */
export const EMPLOYEE_RECORD_SENSITIVE_SELECT =
  '+governmentIds.tin +governmentIds.sss +governmentIds.philhealth +governmentIds.pagibig +bankAccount.accountNumber';

const mobileField = {
  type: String,
  default: null,
  match: [MOBILE_NUMBER_PATTERN, 'A mobile number is 11 digits starting with 09.'] as [
    RegExp,
    string,
  ],
};

const emergencyContactSchema = new Schema<EmergencyContact>(
  {
    name: {
      type: String,
      default: null,
      trim: true,
      maxlength: EMERGENCY_CONTACT_NAME_MAX_LENGTH,
    },
    relationship: {
      type: String,
      default: null,
      trim: true,
      maxlength: EMERGENCY_CONTACT_RELATIONSHIP_MAX_LENGTH,
    },
    mobileNumber: mobileField,
  },
  { _id: false },
);

const employeeRecordSchema = new Schema<EmployeeRecordDocument>({
  employeeId: { type: Schema.Types.ObjectId, required: true, immutable: true },
  // Personal
  dateOfBirth: { type: Date, default: null },
  sex: { type: String, enum: [...SEXES, null], default: null },
  civilStatus: { type: String, enum: [...CIVIL_STATUSES, null], default: null },
  nationality: { type: String, default: null, trim: true, maxlength: NATIONALITY_MAX_LENGTH },
  presentAddress: { type: String, default: null, trim: true, maxlength: ADDRESS_MAX_LENGTH },
  permanentAddress: { type: String, default: null, trim: true, maxlength: ADDRESS_MAX_LENGTH },
  mobileNumber: mobileField,
  personalEmail: {
    type: String,
    default: null,
    trim: true,
    lowercase: true,
    maxlength: PERSONAL_EMAIL_MAX_LENGTH,
  },
  emergencyContact: { type: emergencyContactSchema, default: null },
  // Employment
  workRegion: { type: String, enum: WORK_REGIONS, required: true, default: DEFAULT_WORK_REGION },
  contractEndDate: { type: Date, default: null },
  regularizationDate: { type: Date, default: null },
  separationRemarks: {
    type: String,
    default: null,
    trim: true,
    maxlength: SEPARATION_REMARKS_MAX_LENGTH,
  },
  // Government IDs (a nested object)
  governmentIds: {
    tin: sensitiveField(),
    sss: sensitiveField(),
    philhealth: sensitiveField(),
    pagibig: sensitiveField(),
    rdoCode: {
      type: String,
      default: null,
      match: [new RegExp(`^\\d{${RDO_CODE_DIGITS}}$`), 'An RDO code is 3 digits.'],
    },
  },
  // Payroll bank account (a nested object)
  bankAccount: {
    bank: { type: String, enum: [...PAYROLL_BANKS, null], default: null },
    accountNumber: sensitiveField(),
    accountName: { type: String, default: null, trim: true, maxlength: ACCOUNT_NAME_MAX_LENGTH },
  },
  // Skills (build step 2.2, decision 183): free-text tags, up to 30 of up to 50 characters, unique
  // ignoring case. The service parses them with `skillsField` first; this is the backstop.
  skills: {
    type: [{ type: String, trim: true, minlength: 1, maxlength: SKILL_MAX_LENGTH }],
    default: [],
    validate: {
      validator: (skills: string[]) =>
        skills.length <= SKILLS_MAX_COUNT &&
        new Set(skills.map((skill) => skill.toLocaleLowerCase('en'))).size === skills.length,
      message: `Add at most ${SKILLS_MAX_COUNT} skills, each once.`,
    },
  },
  version: { type: Number, required: true, min: 1 },
});

employeeRecordSchema.index({ employeeId: 1 }, { unique: true });

const ALLOWED_OPERATORS = new Set(['$set', '$unset', '$inc']);

// Spec: docs/DATA_MODEL.md#locked-and-append-only-records — employee records are never deleted,
// and deletes and replacements are refused.
guardWrites(employeeRecordSchema, {
  message:
    'Employee records are never deleted or replaced. Save a section through the employee record service instead.',
  allowUpdate: (update, query) =>
    hasOnlyKeys(update, ALLOWED_OPERATORS) &&
    Object.keys(update).length > 0 &&
    query.getOptions().overwrite !== true,
});

// Never deleted, so no soft delete either.
employeeRecordSchema.plugin(baseSchemaPlugin, { softDelete: false });

export const EmployeeRecordModel = defineModel(
  'EmployeeRecord',
  employeeRecordSchema,
  'employeeRecords',
);
