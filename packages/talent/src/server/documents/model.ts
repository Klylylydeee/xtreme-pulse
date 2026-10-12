import { Schema, type Types } from 'mongoose';
import { baseSchemaPlugin, defineModel } from '@pulse/db';
import { guardWrites, hasOnlyKeys } from '@pulse/core/server';
import { DOCUMENT_201_TYPES, type Document201Type } from '../../fixed-sets';
import { ARCHIVE_REASON_MAX_LENGTH, DOCUMENT_TITLE_MAX_LENGTH } from '../../validation';

// Spec: docs/DATA_MODEL.md#collection-ownership ("Documents, photo, e-signature and
// certifications") and #locked-and-append-only-records, decision 178 in docs/BUILD_PLAN.md — the
// 201 file. One record per document, never deleted: archiving is an update with a reason. The
// employee and the file are fixed once set; the details can be edited with the `version` check.
// A renewal is a new document, which can archive the one it replaces in the same transaction.
//
// Every date is the Manila day at 00:00, stored as UTC.

export interface EmployeeDocumentRecord {
  _id: Types.ObjectId;
  employeeId: Types.ObjectId;
  fileId: Types.ObjectId;
  type: Document201Type;
  title: string | null;
  issueDate: Date;
  expiryDate: Date | null;
  archivedAt: Date | null;
  archivedBy: Types.ObjectId | null;
  archiveReason: string | null;
  /** Raised by every save, for the stale-form check. */
  version: number;
  createdAt: Date;
  updatedAt: Date;
  createdBy: Types.ObjectId | null;
  updatedBy: Types.ObjectId | null;
}

const employeeDocumentSchema = new Schema<EmployeeDocumentRecord>({
  employeeId: { type: Schema.Types.ObjectId, required: true, immutable: true },
  fileId: { type: Schema.Types.ObjectId, required: true, immutable: true },
  type: { type: String, enum: DOCUMENT_201_TYPES, required: true },
  title: {
    type: String,
    default: null,
    trim: true,
    maxlength: DOCUMENT_TITLE_MAX_LENGTH,
    validate: {
      // "Other" needs a title. On a query update, `this` is the query: the service checks there.
      validator(this: unknown, value: string | null) {
        const doc = this as { type?: unknown } | null;
        if (!doc || typeof doc.type !== 'string') return true;
        return doc.type !== 'other' || (typeof value === 'string' && value.trim() !== '');
      },
      message: 'Enter a title for this document.',
    },
  },
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
  archivedAt: { type: Date, default: null },
  archivedBy: { type: Schema.Types.ObjectId, default: null },
  archiveReason: { type: String, default: null, trim: true, maxlength: ARCHIVE_REASON_MAX_LENGTH },
  version: { type: Number, required: true, min: 1 },
});

employeeDocumentSchema.index({ employeeId: 1, createdAt: -1 });
// The expiry job's scan: unarchived documents with an expiry date.
employeeDocumentSchema.index(
  { expiryDate: 1 },
  { partialFilterExpression: { archivedAt: null, expiryDate: { $type: 'date' } } },
);

const ALLOWED_OPERATORS = new Set(['$set', '$inc']);

// Never deleted or replaced. The one allowed write after the insert is an operator update ($set,
// $inc) through updateOne or findOneAndUpdate, which the service makes with the `version` check.
guardWrites(employeeDocumentSchema, {
  message:
    '201 documents are never deleted or replaced. Archive one, or edit its details, through the document service.',
  allowUpdate: (update, query) =>
    hasOnlyKeys(update, ALLOWED_OPERATORS) &&
    Object.keys(update).length > 0 &&
    query.getOptions().overwrite !== true,
});

// Never deleted, so no soft delete either.
employeeDocumentSchema.plugin(baseSchemaPlugin, { softDelete: false });

export const EmployeeDocumentModel = defineModel(
  'EmployeeDocument',
  employeeDocumentSchema,
  'employeeDocuments',
);
