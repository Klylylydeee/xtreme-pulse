import { Schema, type Types } from 'mongoose';
import { baseSchemaPlugin, defineModel } from '@pulse/db';
import { guardWrites, hasOnlyKeys, sensitiveField } from '@pulse/core/server';
import { CHANGE_REQUEST_NOTE_MAX_LENGTH } from '../../onboarding/change-requests';
import {
  CHANGE_REQUEST_SECTIONS,
  CHANGE_REQUEST_STATUSES,
  type ChangeRequestSection,
  type ChangeRequestStatus,
  CIVIL_STATUSES,
  type CivilStatus,
  PAYROLL_BANKS,
  type PayrollBank,
  SEXES,
  type Sex,
} from '../../fixed-sets';
import type { EmergencyContact } from '../employee-records/model';

// Spec: docs/DATA_MODEL.md#collection-ownership (`changeRequests`, build step 2.6) and
// docs/modules/talent.md#onboarding-checklist-and-change-requests-build-step-26 ("Change
// requests"; decision 272 in docs/BUILD_PLAN.md) — an employee's request to change one section of
// their own record, approved through Core's approvals engine (`talent.changeRequest`).
//
// - `proposed` holds only the changed fields, in the employee record's shapes; `previous` is set
//   once on approval with the values replaced. The TIN, SSS, PhilHealth PIN, Pag-IBIG MID and
//   account number are `sensitiveField()`s in both (stored as ciphertext; the collection's
//   `$jsonSchema` validator refuses a plain value), left out of queries unless selected.
// - Never deleted or replaced: the one allowed write after the insert is an operator update ($set,
//   $unset, $inc) with the `version` check. Approved, rejected and cancelled are final.
// - At most one open (`pending` or `returned`) request per employee per section, by a partial
//   unique index.
// - Written only by Talent's change request service and its approval hook.

/** The changed fields' values, in the employee record's shapes. A cleared field is null. */
export interface ChangeRequestValues {
  presentAddress?: string | null;
  permanentAddress?: string | null;
  mobileNumber?: string | null;
  personalEmail?: string | null;
  emergencyContact?: EmergencyContact | null;
  skills?: string[];
  dateOfBirth?: Date | null;
  sex?: Sex | null;
  civilStatus?: CivilStatus | null;
  nationality?: string | null;
  tin?: Buffer;
  sss?: Buffer;
  philhealth?: Buffer;
  pagibig?: Buffer;
  rdoCode?: string | null;
  bank?: PayrollBank | null;
  accountNumber?: Buffer;
  accountName?: string | null;
}

export interface ChangeRequestDocument {
  _id: Types.ObjectId;
  employeeId: Types.ObjectId;
  requesterUserId: Types.ObjectId;
  section: ChangeRequestSection;
  changedFields: string[];
  proposed: ChangeRequestValues;
  previous: ChangeRequestValues | null;
  note: string | null;
  status: ChangeRequestStatus;
  /** When it was last sent (the first send, or "Edit and send again"). */
  sentAt: Date;
  /** The current Core approval request. */
  approvalRequestId: Types.ObjectId | null;
  decidedBy: Types.ObjectId | null;
  decidedAt: Date | null;
  remarks: string | null;
  version: number;
  createdAt: Date;
  updatedAt: Date;
  createdBy: Types.ObjectId | null;
  updatedBy: Types.ObjectId | null;
}

/** Every sensitive path, for `.select()` when the stored values are needed (apply, last 4). */
export const CHANGE_REQUEST_SENSITIVE_SELECT = ['proposed', 'previous']
  .flatMap((group) =>
    ['tin', 'sss', 'philhealth', 'pagibig', 'accountNumber'].map((field) => `+${group}.${field}`),
  )
  .join(' ');

const emergencyContactSchema = new Schema<EmergencyContact>(
  {
    name: { type: String, default: null },
    relationship: { type: String, default: null },
    mobileNumber: { type: String, default: null },
  },
  { _id: false },
);

/** The values subdocument. Formats are checked by the record's schemas before a request is made. */
const valuesSchema = new Schema<ChangeRequestValues>(
  {
    presentAddress: { type: String },
    permanentAddress: { type: String },
    mobileNumber: { type: String },
    personalEmail: { type: String },
    emergencyContact: { type: emergencyContactSchema },
    skills: { type: [String], default: undefined },
    dateOfBirth: { type: Date },
    sex: { type: String, enum: [...SEXES, null] },
    civilStatus: { type: String, enum: [...CIVIL_STATUSES, null] },
    nationality: { type: String },
    tin: sensitiveField(),
    sss: sensitiveField(),
    philhealth: sensitiveField(),
    pagibig: sensitiveField(),
    rdoCode: { type: String },
    bank: { type: String, enum: [...PAYROLL_BANKS, null] },
    accountNumber: sensitiveField(),
    accountName: { type: String },
  },
  { _id: false, minimize: false },
);

const changeRequestSchema = new Schema<ChangeRequestDocument>({
  employeeId: { type: Schema.Types.ObjectId, required: true, immutable: true },
  requesterUserId: { type: Schema.Types.ObjectId, required: true, immutable: true },
  section: { type: String, enum: CHANGE_REQUEST_SECTIONS, required: true, immutable: true },
  changedFields: {
    type: [String],
    required: true,
    validate: {
      validator: (fields: string[]) => fields.length > 0,
      message: 'A change request changes at least one field.',
    },
  },
  proposed: { type: valuesSchema, required: true },
  previous: { type: valuesSchema, default: null },
  note: { type: String, default: null, trim: true, maxlength: CHANGE_REQUEST_NOTE_MAX_LENGTH },
  status: { type: String, enum: CHANGE_REQUEST_STATUSES, required: true },
  sentAt: { type: Date, required: true },
  approvalRequestId: { type: Schema.Types.ObjectId, default: null },
  decidedBy: { type: Schema.Types.ObjectId, default: null },
  decidedAt: { type: Date, default: null },
  remarks: { type: String, default: null },
  version: { type: Number, required: true, min: 1 },
});

changeRequestSchema.index({ employeeId: 1, createdAt: -1 });
// One open request per employee per section.
changeRequestSchema.index(
  { employeeId: 1, section: 1 },
  { unique: true, partialFilterExpression: { status: { $in: ['pending', 'returned'] } } },
);

const ALLOWED_OPERATORS = new Set(['$set', '$unset', '$inc']);

guardWrites(changeRequestSchema, {
  message:
    'Change requests are never deleted or replaced. Change one through the change request service instead.',
  allowUpdate: (update, query) =>
    hasOnlyKeys(update, ALLOWED_OPERATORS) &&
    Object.keys(update).length > 0 &&
    query.getOptions().overwrite !== true,
});

// Never deleted, so no soft delete either.
changeRequestSchema.plugin(baseSchemaPlugin, { softDelete: false });

export const ChangeRequestModel = defineModel(
  'ChangeRequest',
  changeRequestSchema,
  'changeRequests',
);
