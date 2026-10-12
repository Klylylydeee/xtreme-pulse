import { Schema, type Types } from 'mongoose';
import { baseSchemaPlugin, defineModel } from '@pulse/db';
import { guardWrites, hasOnlyKeys } from '@pulse/core/server';
import {
  CERTIFICATION_ISSUER_MAX_LENGTH,
  CERTIFICATION_NAME_MAX_LENGTH,
  LICENSE_NUMBER_MAX_LENGTH,
} from '../../validation';

// Spec: docs/DATA_MODEL.md#collection-ownership and docs/modules/talent.md#skills--certifications
// (decision 182 in docs/BUILD_PLAN.md) — an employee's certifications, with the base fields and
// soft delete. Removing one sets `deletedAt` (Talent Owner); hard deletes and replacements are
// refused. The license number is plain (not sensitive) but never leaves the read services.
//
// Every date is the Manila day at 00:00, stored as UTC.

export interface CertificationRecord {
  _id: Types.ObjectId;
  employeeId: Types.ObjectId;
  name: string;
  issuer: string;
  brandId: Types.ObjectId | null;
  licenseNumber: string | null;
  issueDate: Date;
  expiryDate: Date | null;
  attachmentFileId: Types.ObjectId | null;
  version: number;
  deletedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  createdBy: Types.ObjectId | null;
  updatedBy: Types.ObjectId | null;
}

const certificationSchema = new Schema<CertificationRecord>({
  employeeId: { type: Schema.Types.ObjectId, required: true, immutable: true },
  name: {
    type: String,
    required: true,
    trim: true,
    minlength: 1,
    maxlength: CERTIFICATION_NAME_MAX_LENGTH,
  },
  issuer: {
    type: String,
    required: true,
    trim: true,
    minlength: 1,
    maxlength: CERTIFICATION_ISSUER_MAX_LENGTH,
  },
  brandId: { type: Schema.Types.ObjectId, default: null },
  licenseNumber: { type: String, default: null, trim: true, maxlength: LICENSE_NUMBER_MAX_LENGTH },
  issueDate: { type: Date, required: true },
  expiryDate: {
    type: Date,
    default: null,
    validate: {
      validator(this: unknown, value: Date | null) {
        const doc = this as { issueDate?: unknown } | null;
        if (value === null || !doc || !(doc.issueDate instanceof Date)) return true;
        return value.getTime() > doc.issueDate.getTime();
      },
      message: 'The expiry date must be after the issue date.',
    },
  },
  attachmentFileId: { type: Schema.Types.ObjectId, default: null },
  version: { type: Number, required: true, min: 1 },
});

certificationSchema.index({ employeeId: 1 });
certificationSchema.index({ brandId: 1 });
certificationSchema.index({ expiryDate: 1 });

const ALLOWED_OPERATORS = new Set(['$set', '$inc']);

// Removed with a soft delete only: hard deletes and replacements are refused. The one allowed
// write after the insert is an operator update ($set, $inc), made with the `version` check.
guardWrites(certificationSchema, {
  message:
    'Certifications are never hard-deleted or replaced. Edit or remove one through the certification service.',
  allowUpdate: (update, query) =>
    hasOnlyKeys(update, ALLOWED_OPERATORS) &&
    Object.keys(update).length > 0 &&
    query.getOptions().overwrite !== true,
});

certificationSchema.plugin(baseSchemaPlugin, { softDelete: true });

export const CertificationModel = defineModel(
  'Certification',
  certificationSchema,
  'certifications',
);
