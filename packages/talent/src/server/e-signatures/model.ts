import { Schema, type Types } from 'mongoose';
import { baseSchemaPlugin, defineModel } from '@pulse/db';
import { guardWrites } from '@pulse/core/server';
import { SIGNATURE_PURPOSES, type SignaturePurpose } from '../../fixed-sets';

// Spec: docs/DATA_MODEL.md#collection-ownership and #locked-and-append-only-records, decisions 175
// and 176 in docs/BUILD_PLAN.md — the versioned, owner-only e-signature.
//
// - `eSignatures`: one row per uploaded version (1, 2, 3…) of an employee's signature. The current
//   signature is the highest version. Insert-only: a signature is replaced by a new version, never
//   changed, cleared or deleted.
// - `signatureApplications`: one row per use of a signature, pinning the version and its file, so a
//   signed record keeps the version it was signed with after a replacement. Insert-only.

export interface ESignatureRecord {
  _id: Types.ObjectId;
  employeeId: Types.ObjectId;
  version: number;
  fileId: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
  createdBy: Types.ObjectId | null;
  updatedBy: Types.ObjectId | null;
}

const eSignatureSchema = new Schema<ESignatureRecord>({
  employeeId: { type: Schema.Types.ObjectId, required: true, immutable: true },
  version: { type: Number, required: true, min: 1, immutable: true },
  fileId: { type: Schema.Types.ObjectId, required: true, immutable: true },
});

eSignatureSchema.index({ employeeId: 1, version: 1 }, { unique: true });

guardWrites(eSignatureSchema, {
  message: 'E-signatures are never changed or deleted. Upload a new version instead.',
});

eSignatureSchema.plugin(baseSchemaPlugin, { softDelete: false });

export const ESignatureModel = defineModel('ESignature', eSignatureSchema, 'eSignatures');

export interface SignatureApplicationRecord {
  _id: Types.ObjectId;
  employeeId: Types.ObjectId;
  userId: Types.ObjectId;
  signatureId: Types.ObjectId;
  signatureVersion: number;
  fileId: Types.ObjectId;
  target: { type: string; id: Types.ObjectId; label: string };
  purpose: SignaturePurpose;
  appliedAt: Date;
  createdAt: Date;
  updatedAt: Date;
  createdBy: Types.ObjectId | null;
  updatedBy: Types.ObjectId | null;
}

const targetSchema = new Schema<SignatureApplicationRecord['target']>(
  {
    type: {
      type: String,
      required: true,
      immutable: true,
      match: /^[a-z][a-zA-Z0-9]*\.[a-z][a-zA-Z0-9]*$/,
    },
    id: { type: Schema.Types.ObjectId, required: true, immutable: true },
    label: { type: String, required: true, immutable: true, maxlength: 300 },
  },
  { _id: false },
);

const signatureApplicationSchema = new Schema<SignatureApplicationRecord>({
  employeeId: { type: Schema.Types.ObjectId, required: true, immutable: true },
  userId: { type: Schema.Types.ObjectId, required: true, immutable: true },
  signatureId: { type: Schema.Types.ObjectId, required: true, immutable: true },
  signatureVersion: { type: Number, required: true, min: 1, immutable: true },
  fileId: { type: Schema.Types.ObjectId, required: true, immutable: true },
  target: { type: targetSchema, required: true, immutable: true },
  purpose: { type: String, enum: SIGNATURE_PURPOSES, required: true, immutable: true },
  appliedAt: { type: Date, required: true, immutable: true },
});

signatureApplicationSchema.index({ employeeId: 1, appliedAt: -1 });
signatureApplicationSchema.index({ 'target.type': 1, 'target.id': 1 });

guardWrites(signatureApplicationSchema, {
  message: 'Signature applications are never changed or deleted.',
});

signatureApplicationSchema.plugin(baseSchemaPlugin, { softDelete: false });

export const SignatureApplicationModel = defineModel(
  'SignatureApplication',
  signatureApplicationSchema,
  'signatureApplications',
);
